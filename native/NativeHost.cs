using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Net;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;

// DonDownload native messaging host.
//
// Protocol: Chromium-compatible native messaging framing (Helium, Chrome,
// Edge) on stdin/stdout:
//   4-byte little-endian length, then UTF-8 JSON. One request per frame.
//
// The read loop serves both callers: a one-shot sendNativeMessage process that
// receives a single frame and exits, and a long-lived connectNative port that
// keeps this process alive and sends many frames. A request may carry an opaque
// string "id"; the host echoes it on the matching response so the browser can
// multiplex concurrent requests over one port. The id is transport bookkeeping
// only: it is removed before the exact-key schema checks and never reaches the
// desktop bridge.
//
// Supported requests:
//   { "type": "queue-download", "url": "https://example.com/file.zip" }
//   { "type": "probe" }
//   { "type": "queue-captured-source", "url": "https://cdn.example/clip.mp4" }
//   { "type": "handoff-download", "url": "https://example.com/files/report.zip" }
//   { "type": "download-status", "downloadId": "0f8fad5b-d9cb-469f-a165-70867728950e" }
//   { "type": "show-download", "downloadId": "0f8fad5b-d9cb-469f-a165-70867728950e" }
//   { "type": "scan-page", "url": "https://discuss.example/t/topic/123", "cookie": "..." }
//   { "type": "scan-gofile", "shareId": "AbCd1234", "status": "ok", "files": [ { "name": "a.mp4", "size": 123, "url": "https://store3.gofile.io/download/web/id/a.mp4" } ], "unavailable": [ { "name": "b.mp4", "size": 456 } ], "cookie": "..." }
//   { "type": "scan-video", "pageUrl": "https://example.com/watch?v=1", "title": "Demo", "sources": [ { "url": "https://cdn.example/1080.mp4", "kind": "file", "height": 1080 } ], "cookie": "..." }
//   { "type": "analyze-media", "url": "https://example.com/watch?v=1", "cookie": "..." }
//   { "type": "queue-media", "analysisId": "...", "optionId": "...", "force": true, "outputFormat": "mkv", "cookie": "..." }
//   { "type": "media-status", "jobId": "..." }
//   { "type": "cancel-media", "jobId": "..." }
//
// The host validates each exact schema, discovers the per-user desktop bridge
// endpoint, and POSTs only the validated fields to loopback with a bearer
// token. It never accepts commands, paths, file names, raw format selectors or
// filesystem input. All diagnostics go to stderr and never include URLs.
//
// When a bridge request fails because the app is not running, the host starts
// <install>\DonDownload.exe once with --hidden and retries for up to 15 s while
// the app boots. Development builds have no such executable, so they simply
// report the failure as before.
internal static class NativeHost
{
    private const int MaxFrameBytes = 1024 * 1024;
    private const int MaxStateBytes = 8 * 1024;
    // A media analysis can carry many verified options, so the response cap is
    // larger than the tiny queue-download acknowledgement. The frame cap above
    // still bounds the browser-facing message.
    private const int MaxResponseBytes = 512 * 1024;
    private const int MaxUrlLength = 4096;
    private const string AppMarker = "DonDownload";
    private const int StateVersion = 1;
    private const string QueueDownloadOperation = "queue-download";
    private const string ProbeOperation = "probe";
    private const string AnalyzeMediaOperation = "analyze-media";
    private const string QueueMediaOperation = "queue-media";
    private const string MediaStatusOperation = "media-status";
    private const string CancelMediaOperation = "cancel-media";
    private const string QueueCapturedSourceOperation = "queue-captured-source";
    private const string QueueSniffedMediaOperation = "queue-sniffed-media";
    private const string HandoffDownloadOperation = "handoff-download";
    private const string DownloadStatusOperation = "download-status";
    private const string ShowDownloadOperation = "show-download";
    private const string ScanPageOperation = "scan-page";
    private const string ScanImagesOperation = "scan-images";
    private const string ScanGofileOperation = "scan-gofile";
    private const string ScanVideoOperation = "scan-video";
    // One page may report up to 1000 images, each with an optional fallback URL.
    private const int MaxScanImages = 1000;
    // One Gofile share reports at most 500 rendered rows.
    private const int MaxScanGofileFiles = 500;
    // One video page reports at most 24 direct media URLs.
    private const int MaxScanVideoSources = 24;
    private const int MaxScanVideoLabelLength = 80;
    private const int MaxScanVideoTitleLength = 300;
    private const long MaxScanVideoDimension = 100000;
    // 10 TB is far above any real video and keeps the size a sane long.
    private const long MaxScanVideoBytes = 10000000000000L;
    private const int MaxGofileNameLength = 240;
    // 10 TB is far above any real Gofile file and keeps the size a sane long.
    private const long MaxGofileSizeBytes = 10000000000000L;
    private const string StateFileName = "native-bridge.json";
    private const string RequestIdKey = "id";
    // aria2 may need up to ~12 seconds to start on the first add. The host
    // still fails promptly when the loopback port is closed.
    private const int BridgeTimeoutMilliseconds = 20000;
    // Media analysis runs yt-dlp metadata extraction, which the media engine
    // already bounds at 60 seconds. The host must allow that plus bridge
    // overhead instead of cutting a valid analysis off at the regular timeout.
    private const int AnalyzeMediaTimeoutMilliseconds = 90000;
    // When the app is not running this host starts it once and then polls the
    // bridge endpoint until it answers. 250 ms keeps the wait responsive without
    // spinning, and 15 s covers Electron start-up on a slow disk.
    private const int WakeRetryIntervalMilliseconds = 250;
    private const int WakeTimeoutMilliseconds = 15000;
    // The desktop app reads this as "start without showing the window".
    private const string HiddenStartArgument = "--hidden";
    // The packaged layout puts the host in <install>\resources\native and the
    // app at <install>\DonDownload.exe. A development checkout has no such exe,
    // so a dev host never tries to start anything.
    private const string AppExecutableName = "DonDownload.exe";

    private static readonly Regex TokenPattern =
        new Regex("^[0-9a-f]{64}$", RegexOptions.CultureInvariant);
    // Browser-generated request ids for the persistent port. Short, opaque and
    // never interpreted.
    private static readonly Regex RequestIdPattern =
        new Regex("^[A-Za-z0-9_-]{1,64}$", RegexOptions.CultureInvariant);
    private static readonly Regex ExtensionOriginPattern =
        new Regex("^chrome-extension://[a-p]{32}/?$", RegexOptions.CultureInvariant);
    private static readonly Regex OpaqueMediaIdPattern =
        new Regex("^[A-Za-z0-9_-]{1,128}$", RegexOptions.CultureInvariant);
    private static readonly Regex ContainerPattern =
        new Regex("^[a-z0-9][a-z0-9._+-]{0,31}$", RegexOptions.CultureInvariant);
    private static readonly Regex ErrorCodePattern =
        new Regex("^[A-Z][A-Z0-9_]{1,63}$", RegexOptions.CultureInvariant);
    private static readonly Regex ProgressiveExtensionPattern =
        new Regex("\\.(mp4|webm|m4v|mov|ogv|mkv)/?$", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
    private static readonly Regex HandoffExtensionPattern =
        new Regex("\\.(7z|apk|bin|bz2|csv|deb|dmg|doc|docx|epub|exe|funscript|gz|img|iso|jar|json|md|msi|odp|ods|odt|pkg|pdf|ppt|pptx|rar|rpm|sqlite|tar|tgz|txt|whl|xls|xlsx|xz|zip|zst)/?$",
            RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
    // Automatic browser hand-off takes over a normal browser download, so a
    // direct media file is accepted too. Pages, playlists and segments are not.
    private static readonly Regex HandoffPageOrManifestExtensionPattern =
        new Regex("\\.(html|htm|xhtml|shtml|m3u8|mpd|m4s|ts)/?$",
            RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
    private static readonly Regex HandoffPageOrManifestContentTypePattern =
        new Regex("^(text/html|application/xhtml\\+xml|application/dash\\+xml|application/(vnd\\.apple\\.mpegurl|x-mpegurl|mpegurl)|audio/(x-)?mpegurl)$",
            RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
    private static readonly Regex CompleteMediaTypePattern =
        new Regex("^video/(mp4|webm)$", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
    private static readonly Regex ContentTypePattern =
        new Regex("^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$",
            RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
    private static readonly Regex DownloadIdPattern =
        new Regex("^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
            RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

    private static readonly string[] MediaJobStatuses = new string[]
    {
        "queued",
        "analyzing",
        "downloading",
        "merging",
        "complete",
        "error",
        "cancelled",
        "interrupted"
    };

    // The five values the in-page card understands. The desktop maps its own
    // statuses onto these before answering.
    private static readonly string[] HandoffDownloadStatuses = new string[]
    {
        "queued",
        "running",
        "paused",
        "done",
        "error"
    };

    private static readonly JavaScriptSerializer Serializer =
        new JavaScriptSerializer { MaxJsonLength = MaxFrameBytes * 2 };

    private enum FrameStatus
    {
        Ok,
        EndOfStream,
        TooLarge,
        Invalid
    }

    private sealed class BridgeState
    {
        public int Port;
        public string Token;
        public long StartedAt;
    }

    private static int Main(string[] args)
    {
        try
        {
            // Chromium-compatible browsers (Helium, Chrome, Edge) pass the
            // caller origin as the first argument. The browser manifest's
            // allowed_origins is the authoritative origin check; this rejects
            // obviously non-extension launches too.
            if (args.Length > 0 && !ExtensionOriginPattern.IsMatch(args[0]))
            {
                Console.Error.WriteLine("DonDownload native host: unsupported caller origin.");
                return 3;
            }

            return Run();
        }
        catch (Exception error)
        {
            // Never print payloads or URLs.
            Console.Error.WriteLine("DonDownload native host failed: " + error.GetType().Name);
            return 2;
        }
    }

    private static int Run()
    {
        Stream input = Console.OpenStandardInput();
        Stream output = Console.OpenStandardOutput();
        UTF8Encoding utf8 = new UTF8Encoding(false, true);

        while (true)
        {
            int length;
            FrameStatus status = ReadFrameLength(input, out length);

            if (status == FrameStatus.EndOfStream)
            {
                return 0;
            }
            if (status == FrameStatus.TooLarge)
            {
                WriteResponse(output, Error("FRAME_TOO_LARGE", "The native message is too large."));
                return 1;
            }
            if (status == FrameStatus.Invalid)
            {
                WriteResponse(output, Error("FRAME_INVALID", "The native message frame is invalid."));
                return 1;
            }

            byte[] frame = new byte[length];
            if (!ReadExactly(input, frame, 0, frame.Length))
            {
                WriteResponse(output, Error("FRAME_INVALID", "The native message ended unexpectedly."));
                return 1;
            }

            string json;
            try
            {
                json = utf8.GetString(frame);
            }
            catch (DecoderFallbackException)
            {
                WriteResponse(output, Error("INVALID_JSON", "The native message is not valid UTF-8."));
                continue;
            }

            Dictionary<string, object> response = HandleMessage(json);
            WriteResponse(output, response);
        }
    }

    private static Dictionary<string, object> HandleMessage(string json)
    {
        object parsed;
        try
        {
            parsed = Serializer.DeserializeObject(json);
        }
        catch (Exception)
        {
            return Error("INVALID_JSON", "The native message is not valid JSON.");
        }

        Dictionary<string, object> message = parsed as Dictionary<string, object>;
        if (message == null)
        {
            return Error("INVALID_MESSAGE", "The native message is missing its operation.");
        }

        string requestId = null;
        if (message.ContainsKey(RequestIdKey))
        {
            requestId = message[RequestIdKey] as string;
            message.Remove(RequestIdKey);
            if (requestId == null || !RequestIdPattern.IsMatch(requestId))
            {
                return Error("INVALID_MESSAGE", "The native message request id is invalid.");
            }
        }

        Dictionary<string, object> response = WithAppWake(
            delegate { return DispatchMessage(message); });
        if (requestId != null)
        {
            response[RequestIdKey] = requestId;
        }
        return response;
    }

    /// <summary>
    /// Runs one request and, when the desktop bridge is unavailable, starts the
    /// app once and then retries the request while it boots. Later requests use
    /// the single wake window opened by that first attempt instead of starting
    /// the app again or waiting a fresh 15 s each.
    /// </summary>
    private static Dictionary<string, object> WithAppWake(
        Func<Dictionary<string, object>> operation)
    {
        Dictionary<string, object> response = operation();
        if (!IsAppNotRunning(response))
        {
            return response;
        }

        DateTime deadline;
        if (!TryStartAppAndGetRetryDeadline(out deadline))
        {
            return response;
        }

        while (DateTime.UtcNow < deadline)
        {
            Thread.Sleep(WakeRetryIntervalMilliseconds);
            // Re-running the request re-reads the per-user bridge state file,
            // which only exists while the app is running.
            response = operation();
            if (!IsAppNotRunning(response))
            {
                return response;
            }
        }
        return response;
    }

    private static bool IsAppNotRunning(Dictionary<string, object> response)
    {
        if (response == null)
        {
            return false;
        }

        object okValue;
        if (!response.TryGetValue("ok", out okValue) || !(okValue is bool) || (bool)okValue)
        {
            return false;
        }

        Dictionary<string, object> error = response.ContainsKey("error")
            ? response["error"] as Dictionary<string, object>
            : null;
        return error != null &&
            error.ContainsKey("code") &&
            (error["code"] as string) == "APP_NOT_RUNNING";
    }

    // The app is started at most once per host process, and only when the
    // packaged layout actually has it. A development checkout never does.
    private static readonly object WakeLock = new object();
    private static bool wakeAttempted;
    private static DateTime wakeRetryDeadline = DateTime.MinValue;

    private static bool TryStartAppAndGetRetryDeadline(out DateTime deadline)
    {
        lock (WakeLock)
        {
            if (!wakeAttempted)
            {
                wakeAttempted = true;
                string executable = ResolveAppExecutable();
                if (executable != null)
                {
                    try
                    {
                        ProcessStartInfo startInfo = new ProcessStartInfo(
                            executable,
                            HiddenStartArgument);
                        // ShellExecute keeps the browser's native messaging
                        // pipes out of the child entirely. A plain CreateProcess
                        // would let the started app inherit this host's stdin
                        // and stdout, which would keep the port open after the
                        // host exits.
                        startInfo.UseShellExecute = true;
                        startInfo.WorkingDirectory = Path.GetDirectoryName(executable);
                        Process.Start(startInfo);
                        wakeRetryDeadline = DateTime.UtcNow.AddMilliseconds(
                            WakeTimeoutMilliseconds);
                    }
                    catch (Exception)
                    {
                        // Starting the app is best effort. The caller still gets
                        // the existing "not running" answer.
                        wakeRetryDeadline = DateTime.MinValue;
                    }
                }
            }

            deadline = wakeRetryDeadline;
            return deadline != DateTime.MinValue && DateTime.UtcNow < deadline;
        }
    }

    private static string ResolveAppExecutable()
    {
        try
        {
            // <install>\resources\native\dondownload-native-host.exe means the
            // app executable is two directories above the host.
            string hostPath = typeof(NativeHost).Assembly.Location;
            string hostDirectory = string.IsNullOrEmpty(hostPath)
                ? AppDomain.CurrentDomain.BaseDirectory
                : Path.GetDirectoryName(hostPath);
            if (string.IsNullOrEmpty(hostDirectory))
            {
                return null;
            }

            string candidate = Path.GetFullPath(
                Path.Combine(hostDirectory, "..", "..", AppExecutableName));
            return File.Exists(candidate) ? candidate : null;
        }
        catch (Exception)
        {
            return null;
        }
    }

    private static Dictionary<string, object> DispatchMessage(Dictionary<string, object> message)
    {
        if (!message.ContainsKey("type"))
        {
            return Error("INVALID_MESSAGE", "The native message is missing its operation.");
        }

        string type = message["type"] as string;
        if (type == null)
        {
            return Error("INVALID_MESSAGE", "The native message operation is invalid.");
        }

        if (type == QueueDownloadOperation)
        {
            return HandleQueueDownloadMessage(message);
        }
        if (type == ProbeOperation)
        {
            return HandleProbeMessage(message);
        }
        if (type == AnalyzeMediaOperation)
        {
            return HandleAnalyzeMediaMessage(message);
        }
        if (type == QueueMediaOperation)
        {
            return HandleQueueMediaMessage(message);
        }
        if (type == MediaStatusOperation || type == CancelMediaOperation)
        {
            return HandleMediaJobMessage(message, type);
        }
        if (type == QueueCapturedSourceOperation)
        {
            return HandleQueueCapturedSourceMessage(message);
        }
        if (type == QueueSniffedMediaOperation)
        {
            return HandleQueueSniffedMediaMessage(message);
        }
        if (type == HandoffDownloadOperation)
        {
            return HandleHandoffDownloadMessage(message);
        }
        if (type == DownloadStatusOperation)
        {
            return HandleDownloadStatusMessage(message);
        }
        if (type == ShowDownloadOperation)
        {
            return HandleShowDownloadMessage(message);
        }
        if (type == ScanPageOperation)
        {
            return HandleScanPageMessage(message);
        }
        if (type == ScanImagesOperation)
        {
            return HandleScanImagesMessage(message);
        }
        if (type == ScanGofileOperation)
        {
            return HandleScanGofileMessage(message);
        }
        if (type == ScanVideoOperation)
        {
            return HandleScanVideoMessage(message);
        }

        return Error("UNSUPPORTED_OPERATION", "Unsupported native operation.");
    }

    private static Dictionary<string, object> HandleProbeMessage(
        Dictionary<string, object> message)
    {
        if (!HasExactKeys(message, new string[] { "type" }, new string[0]))
        {
            return Error(
                "INVALID_MESSAGE",
                "Only probe messages containing exactly a type field are accepted.");
        }

        Dictionary<string, object> response = new Dictionary<string, object>();
        response.Add("ok", true);
        response.Add("operation", ProbeOperation);
        return response;
    }

    private static Dictionary<string, object> HandleQueueDownloadMessage(
        Dictionary<string, object> message)
    {
        if (!HasExactKeys(message, new string[] { "type", "url" }, new string[] { "force" }))
        {
            return Error(
                "INVALID_MESSAGE",
                "Only queue-download messages containing type, url and an optional force flag are accepted.");
        }

        bool force = false;
        if (message.ContainsKey("force"))
        {
            object forceValue = message["force"];
            if (!(forceValue is bool))
            {
                return Error("INVALID_MESSAGE", "The force option must be true or false.");
            }
            force = (bool)forceValue;
        }

        string normalizedUrl;
        string urlError;
        if (!TryNormalizeUrl(message["url"] as string, out normalizedUrl, out urlError))
        {
            return Error("INVALID_URL", urlError);
        }

        return QueueDownload(normalizedUrl, force);
    }

    private static Dictionary<string, object> HandleAnalyzeMediaMessage(
        Dictionary<string, object> message)
    {
        if (!HasExactKeys(
            message,
            new string[] { "type", "url" },
            new string[] { "cookie" }))
        {
            return Error(
                "INVALID_MESSAGE",
                "Only analyze-media messages containing type, url and an optional cookie are accepted.");
        }

        string normalizedUrl;
        string urlError;
        if (!TryNormalizeUrl(message["url"] as string, out normalizedUrl, out urlError))
        {
            return Error("INVALID_URL", urlError);
        }

        string cookie = null;
        if (message.ContainsKey("cookie"))
        {
            cookie = message["cookie"] as string;
            if (!IsSafeHeaderValue(cookie, 8192))
            {
                return Error("INVALID_MESSAGE", "The browser cookie header is invalid.");
            }
        }

        Dictionary<string, object> body = new Dictionary<string, object>();
        body.Add("url", normalizedUrl);
        if (cookie != null)
        {
            body.Add("cookie", cookie);
        }
        return ForwardMedia(AnalyzeMediaOperation, "/analyze-media", body);
    }

    private static Dictionary<string, object> HandleQueueMediaMessage(
        Dictionary<string, object> message)
    {
        if (!HasExactKeys(
            message,
            new string[] { "type", "analysisId", "optionId" },
            new string[] { "force", "outputFormat", "cookie" }))
        {
            return Error(
                "INVALID_MESSAGE",
                "Only queue-media messages containing type, analysisId, optionId, optional force/outputFormat and an optional cookie are accepted.");
        }

        if (!IsOpaqueMediaId(message["analysisId"]))
        {
            return Error("INVALID_MESSAGE", "The media analysis identifier is invalid.");
        }
        if (!IsOpaqueMediaId(message["optionId"]))
        {
            return Error("INVALID_MESSAGE", "The media option identifier is invalid.");
        }

        bool force = false;
        if (message.ContainsKey("force"))
        {
            object forceValue = message["force"];
            if (!(forceValue is bool))
            {
                return Error("INVALID_MESSAGE", "The force option must be true or false.");
            }
            force = (bool)forceValue;
        }

        string outputFormat = null;
        if (message.ContainsKey("outputFormat"))
        {
            outputFormat = message["outputFormat"] as string;
            if (outputFormat != "auto" &&
                outputFormat != "mp4" &&
                outputFormat != "mkv" &&
                outputFormat != "webm")
            {
                return Error(
                    "INVALID_MESSAGE",
                    "The output format must be auto, mp4, mkv or webm.");
            }
        }

        string cookie = null;
        if (message.ContainsKey("cookie"))
        {
            cookie = message["cookie"] as string;
            if (!IsSafeHeaderValue(cookie, 8192))
            {
                return Error("INVALID_MESSAGE", "The browser cookie header is invalid.");
            }
        }

        Dictionary<string, object> body = new Dictionary<string, object>();
        body.Add("analysisId", (string)message["analysisId"]);
        body.Add("optionId", (string)message["optionId"]);
        if (force)
        {
            body.Add("force", true);
        }
        if (outputFormat != null)
        {
            body.Add("outputFormat", outputFormat);
        }
        if (cookie != null)
        {
            body.Add("cookie", cookie);
        }
        return ForwardMedia(QueueMediaOperation, "/queue-media", body);
    }

    private static Dictionary<string, object> HandleQueueCapturedSourceMessage(
        Dictionary<string, object> message)
    {
        if (!HasExactKeys(
            message,
            new string[] { "type", "url" },
            new string[] { "filename", "contentType", "expectedBytes", "referer", "userAgent" }))
        {
            return Error(
                "INVALID_MESSAGE",
                "Only queue-captured-source messages containing type, url and optional filename/contentType/expectedBytes/referer/userAgent are accepted.");
        }

        string normalizedUrl;
        string urlError;
        if (!TryNormalizeUrl(message["url"] as string, out normalizedUrl, out urlError))
        {
            return Error("INVALID_URL", urlError);
        }

        string filename = null;
        if (message.ContainsKey("filename"))
        {
            filename = message["filename"] as string;
            if (!IsSafeCapturedFilename(filename))
            {
                return Error("INVALID_MESSAGE", "The captured source filename is invalid.");
            }
        }

        string contentType = null;
        long expectedBytes = 0;
        bool hasContentType = message.ContainsKey("contentType");
        bool hasExpectedBytes = message.ContainsKey("expectedBytes");
        if (hasContentType != hasExpectedBytes)
        {
            return Error(
                "INVALID_MESSAGE",
                "An extensionless captured source requires both contentType and expectedBytes.");
        }
        if (hasContentType)
        {
            contentType = message["contentType"] as string;
            if (contentType == null || !CompleteMediaTypePattern.IsMatch(contentType))
            {
                return Error("INVALID_MESSAGE", "The captured source content type is invalid.");
            }
            contentType = contentType.ToLowerInvariant();
            if (!TryReadPositiveLong(message["expectedBytes"], out expectedBytes))
            {
                return Error("INVALID_MESSAGE", "The captured source size is invalid.");
            }
        }

        bool progressive = false;
        try
        {
            progressive = ProgressiveExtensionPattern.IsMatch(
                new Uri(normalizedUrl).AbsolutePath);
        }
        catch (Exception)
        {
            return Error("INVALID_URL", "That does not look like a valid URL.");
        }
        if (!progressive && filename != null)
        {
            progressive = ProgressiveExtensionPattern.IsMatch(filename);
        }
        if (!progressive && !hasContentType)
        {
            return Error(
                "CAPTURED_SOURCE_UNSUPPORTED",
                "The captured source is not a supported progressive media file.");
        }

        Dictionary<string, object> body = new Dictionary<string, object>();
        body.Add("url", normalizedUrl);
        if (filename != null)
        {
            body.Add("filename", filename);
        }
        if (hasContentType)
        {
            body.Add("contentType", contentType);
            body.Add("expectedBytes", expectedBytes);
        }
        if (message.ContainsKey("referer"))
        {
            string capturerReferer;
            string refererError;
            if (!TryNormalizeUrl(message["referer"] as string, out capturerReferer, out refererError) ||
                capturerReferer.Length > 4096)
            {
                return Error("INVALID_MESSAGE", "The captured source referer is invalid.");
            }
            body.Add("referer", capturerReferer);
        }
        if (message.ContainsKey("userAgent"))
        {
            string capturerUserAgent = message["userAgent"] as string;
            if (!IsSafeHeaderValue(capturerUserAgent, 512))
            {
                return Error("INVALID_MESSAGE", "The captured source user agent is invalid.");
            }
            body.Add("userAgent", capturerUserAgent);
        }
        return ForwardCapturedSource(body);
    }

    private static Dictionary<string, object> HandleQueueSniffedMediaMessage(
        Dictionary<string, object> message)
    {
        if (!HasExactKeys(
            message,
            new string[]
            {
                "type",
                "url",
                "pageUrl",
                "referer",
                "userAgent",
                "kind",
                "title"
            },
            new string[] { "filename", "variant", "cookie", "expectedBytes" }))
        {
            return Error(
                "INVALID_MESSAGE",
                "Only queue-sniffed-media messages with type,url,pageUrl,referer,userAgent,kind,title and optional filename/variant/cookie/expectedBytes are accepted.");
        }

        string normalizedUrl;
        string urlError;
        if (!TryNormalizeUrl(message["url"] as string, out normalizedUrl, out urlError))
        {
            return Error("INVALID_URL", urlError);
        }
        string pageUrl;
        if (!TryNormalizeUrl(message["pageUrl"] as string, out pageUrl, out urlError))
        {
            return Error("INVALID_URL", urlError);
        }
        string referer;
        if (!TryNormalizeUrl(message["referer"] as string, out referer, out urlError))
        {
            return Error("INVALID_URL", urlError);
        }
        try
        {
            Uri pageUri = new Uri(pageUrl);
            Uri refererUri = new Uri(referer);
            if (pageUri.GetLeftPart(UriPartial.Authority) !=
                refererUri.GetLeftPart(UriPartial.Authority))
            {
                return Error(
                    "INVALID_MESSAGE",
                    "The detected media referer must belong to the page origin.");
            }
        }
        catch (Exception)
        {
            return Error("INVALID_URL", "That does not look like a valid URL.");
        }

        string kind = message["kind"] as string;
        if (kind != "file" && kind != "hls" && kind != "dash")
        {
            return Error("INVALID_MESSAGE", "The detected media kind is unsupported.");
        }

        string userAgent = message["userAgent"] as string;
        if (!IsSafeHeaderValue(userAgent, 512))
        {
            return Error("INVALID_MESSAGE", "The detected media user agent is invalid.");
        }
        string title = message["title"] as string;
        if (!IsSafeText(title, 500))
        {
            return Error("INVALID_MESSAGE", "The detected media title is invalid.");
        }

        string filename = null;
        if (message.ContainsKey("filename"))
        {
            filename = message["filename"] as string;
            if (!IsSafeCapturedFilename(filename))
            {
                return Error("INVALID_MESSAGE", "The detected media filename is invalid.");
            }
        }

        Dictionary<string, object> variant = null;
        if (message.ContainsKey("variant"))
        {
            variant = message["variant"] as Dictionary<string, object>;
            if (variant == null ||
                !HasExactKeys(
                    variant,
                    new string[] { "url" },
                    new string[] { "label", "width", "height", "bandwidth" }))
            {
                return Error("INVALID_MESSAGE", "The detected HLS variant is invalid.");
            }
            string variantUrl;
            if (!TryNormalizeUrl(variant["url"] as string, out variantUrl, out urlError))
            {
                return Error("INVALID_URL", urlError);
            }
            variant = new Dictionary<string, object>(variant);
            variant["url"] = variantUrl;
            if (variant.ContainsKey("label") &&
                !IsSafeText(variant["label"] as string, 80))
            {
                return Error("INVALID_MESSAGE", "The detected HLS variant label is invalid.");
            }
            foreach (string key in new string[] { "width", "height", "bandwidth" })
            {
                long number;
                if (variant.ContainsKey(key) &&
                    !TryReadPositiveLong(variant[key], out number))
                {
                    return Error("INVALID_MESSAGE", "The detected HLS variant metadata is invalid.");
                }
            }
            if (kind != "hls")
            {
                return Error("INVALID_MESSAGE", "Only an HLS entry may pin a variant.");
            }
        }

        string cookie = null;
        if (message.ContainsKey("cookie"))
        {
            cookie = message["cookie"] as string;
            if (!IsSafeHeaderValue(cookie, 8192))
            {
                return Error("INVALID_MESSAGE", "The browser cookie header is invalid.");
            }
        }

        long expectedBytes = 0;
        if (message.ContainsKey("expectedBytes") &&
            !TryReadPositiveLong(message["expectedBytes"], out expectedBytes))
        {
            return Error("INVALID_MESSAGE", "The detected media size is invalid.");
        }

        Dictionary<string, object> body = new Dictionary<string, object>();
        body.Add("url", normalizedUrl);
        body.Add("pageUrl", pageUrl);
        body.Add("referer", referer);
        body.Add("userAgent", userAgent);
        body.Add("kind", kind);
        body.Add("title", title);
        if (filename != null)
        {
            body.Add("filename", filename);
        }
        if (variant != null)
        {
            body.Add("variant", variant);
        }
        if (cookie != null)
        {
            body.Add("cookie", cookie);
        }
        if (message.ContainsKey("expectedBytes"))
        {
            body.Add("expectedBytes", expectedBytes);
        }
        return ForwardSniffedMedia(body);
    }

    private static Dictionary<string, object> HandleScanPageMessage(
        Dictionary<string, object> message)
    {
        if (!HasExactKeys(
            message,
            new string[] { "type", "url" },
            new string[] { "cookie" }))
        {
            return Error(
                "INVALID_MESSAGE",
                "Only scan-page messages containing type, url and an optional cookie are accepted.");
        }

        string normalizedUrl;
        string urlError;
        if (!TryNormalizeUrl(message["url"] as string, out normalizedUrl, out urlError))
        {
            return Error("INVALID_URL", urlError);
        }

        string cookie = null;
        if (message.ContainsKey("cookie"))
        {
            cookie = message["cookie"] as string;
            if (!IsSafeHeaderValue(cookie, 8192))
            {
                return Error("INVALID_MESSAGE", "The browser cookie header is invalid.");
            }
        }

        Dictionary<string, object> body = new Dictionary<string, object>();
        body.Add("url", normalizedUrl);
        if (cookie != null)
        {
            body.Add("cookie", cookie);
        }
        return ForwardScanPage(body);
    }

    /// <summary>
    /// "Download images on this page". The extension already walked the live DOM,
    /// so this only validates the shape and forwards the list to the desktop
    /// picker. It never fetches a page and never queues a download.
    /// </summary>
    private static Dictionary<string, object> HandleScanImagesMessage(
        Dictionary<string, object> message)
    {
        if (!HasExactKeys(
            message,
            new string[] { "type", "pageUrl", "pageTitle", "images" },
            new string[0]))
        {
            return Error(
                "INVALID_MESSAGE",
                "Only scan-images messages containing type, pageUrl, pageTitle and images are accepted.");
        }

        string pageUrl;
        string urlError;
        if (!TryNormalizeUrl(message["pageUrl"] as string, out pageUrl, out urlError))
        {
            return Error("INVALID_URL", urlError);
        }

        string pageTitle = message["pageTitle"] as string;
        if (pageTitle == null || pageTitle.Length > 200)
        {
            return Error("INVALID_MESSAGE", "The page title is invalid.");
        }

        object[] rawImages = message["images"] as object[];
        if (rawImages == null || rawImages.Length == 0 || rawImages.Length > MaxScanImages)
        {
            return Error("INVALID_MESSAGE", "The image list is invalid.");
        }

        List<object> images = new List<object>();
        for (int index = 0; index < rawImages.Length; index++)
        {
            Dictionary<string, object> raw = rawImages[index] as Dictionary<string, object>;
            if (raw == null ||
                !HasExactKeys(
                    raw,
                    new string[] { "url" },
                    new string[] { "fallbackUrl", "width", "height", "alt" }))
            {
                return Error("INVALID_MESSAGE", "An image entry is invalid.");
            }

            string imageUrl;
            if (!TryNormalizeUrl(raw["url"] as string, out imageUrl, out urlError))
            {
                return Error("INVALID_URL", urlError);
            }

            Dictionary<string, object> entry = new Dictionary<string, object>();
            entry.Add("url", imageUrl);

            if (raw.ContainsKey("fallbackUrl"))
            {
                string fallbackUrl;
                if (!TryNormalizeUrl(raw["fallbackUrl"] as string, out fallbackUrl, out urlError))
                {
                    return Error("INVALID_URL", urlError);
                }
                entry.Add("fallbackUrl", fallbackUrl);
            }
            if (raw.ContainsKey("width"))
            {
                long width;
                if (!TryReadPositiveLong(raw["width"], out width) || width > 100000)
                {
                    return Error("INVALID_MESSAGE", "An image size is invalid.");
                }
                entry.Add("width", width);
            }
            if (raw.ContainsKey("height"))
            {
                long height;
                if (!TryReadPositiveLong(raw["height"], out height) || height > 100000)
                {
                    return Error("INVALID_MESSAGE", "An image size is invalid.");
                }
                entry.Add("height", height);
            }
            if (raw.ContainsKey("alt"))
            {
                string alt = raw["alt"] as string;
                if (alt == null || alt.Length > 200 || !IsSafeHeaderValue(alt, 200))
                {
                    return Error("INVALID_MESSAGE", "An image description is invalid.");
                }
                entry.Add("alt", alt);
            }
            images.Add(entry);
        }

        Dictionary<string, object> body = new Dictionary<string, object>();
        body.Add("pageUrl", pageUrl);
        body.Add("pageTitle", pageTitle);
        body.Add("images", images.ToArray());
        return ForwardScanImages(body);
    }

    /// <summary>
    /// "Scan this Gofile share". The extension read the rows from the user's own
    /// signed-in tab, so this only validates the shape and forwards the list.
    /// Every download URL must be HTTPS on gofile.io or one of its store hosts,
    /// and the optional accountToken Cookie is forwarded once, never stored.
    /// </summary>
    private static Dictionary<string, object> HandleScanGofileMessage(
        Dictionary<string, object> message)
    {
        if (!HasExactKeys(
            message,
            new string[] { "type", "shareId", "status", "files" },
            new string[] { "cookie", "unavailable" }))
        {
            return Error(
                "INVALID_MESSAGE",
                "Only scan-gofile messages containing type, shareId, status, files and an optional cookie or unavailable list are accepted.");
        }

        string shareId = message["shareId"] as string;
        if (!IsGofileShareId(shareId))
        {
            return Error("INVALID_MESSAGE", "The Gofile share identifier is invalid.");
        }

        string status = message["status"] as string;
        if (!IsGofileShareStatus(status))
        {
            return Error("INVALID_MESSAGE", "The Gofile share status is invalid.");
        }

        object[] rawFiles = message["files"] as object[];
        if (rawFiles == null || rawFiles.Length > MaxScanGofileFiles)
        {
            return Error("INVALID_MESSAGE", "The Gofile file list is invalid.");
        }

        List<object> files = new List<object>();
        for (int index = 0; index < rawFiles.Length; index++)
        {
            Dictionary<string, object> raw = rawFiles[index] as Dictionary<string, object>;
            if (raw == null ||
                !HasExactKeys(
                    raw,
                    new string[] { "name", "url" },
                    new string[] { "size" }))
            {
                return Error("INVALID_MESSAGE", "A Gofile file entry is invalid.");
            }

            string name = raw["name"] as string;
            if (!IsSafeHeaderValue(name, MaxGofileNameLength))
            {
                return Error("INVALID_MESSAGE", "A Gofile file name is invalid.");
            }

            string fileUrl;
            string urlError;
            if (!TryNormalizeUrl(raw["url"] as string, out fileUrl, out urlError))
            {
                return Error("INVALID_URL", urlError);
            }
            if (!IsGofileDownloadUrl(fileUrl))
            {
                return Error("INVALID_URL", "A Gofile download link is not on gofile.io.");
            }

            Dictionary<string, object> entry = new Dictionary<string, object>();
            entry.Add("name", name);
            entry.Add("url", fileUrl);
            if (raw.ContainsKey("size") && raw["size"] != null)
            {
                long size;
                if (!TryReadPositiveLong(raw["size"], out size) || size > MaxGofileSizeBytes)
                {
                    return Error("INVALID_MESSAGE", "A Gofile file size is invalid.");
                }
                entry.Add("size", size);
            }
            files.Add(entry);
        }

        // A rendered row whose download URL the page never exposed still names a
        // real file the user can see, so it is forwarded as a name plus an
        // optional size and nothing else.
        List<object> unavailable = new List<object>();
        if (message.ContainsKey("unavailable"))
        {
            object[] rawRows = message["unavailable"] as object[];
            if (rawRows == null || rawRows.Length > MaxScanGofileFiles)
            {
                return Error("INVALID_MESSAGE", "The Gofile row list is invalid.");
            }
            for (int index = 0; index < rawRows.Length; index++)
            {
                Dictionary<string, object> raw = rawRows[index] as Dictionary<string, object>;
                if (raw == null ||
                    !HasExactKeys(raw, new string[] { "name" }, new string[] { "size" }))
                {
                    return Error("INVALID_MESSAGE", "A Gofile row entry is invalid.");
                }

                string rowName = raw["name"] as string;
                if (!IsSafeHeaderValue(rowName, MaxGofileNameLength))
                {
                    return Error("INVALID_MESSAGE", "A Gofile file name is invalid.");
                }

                Dictionary<string, object> row = new Dictionary<string, object>();
                row.Add("name", rowName);
                if (raw.ContainsKey("size") && raw["size"] != null)
                {
                    long rowSize;
                    if (!TryReadPositiveLong(raw["size"], out rowSize) ||
                        rowSize > MaxGofileSizeBytes)
                    {
                        return Error("INVALID_MESSAGE", "A Gofile file size is invalid.");
                    }
                    row.Add("size", rowSize);
                }
                unavailable.Add(row);
            }
        }

        string cookie = null;
        if (message.ContainsKey("cookie"))
        {
            cookie = message["cookie"] as string;
            if (!IsSafeHeaderValue(cookie, 8192))
            {
                return Error("INVALID_MESSAGE", "The browser cookie header is invalid.");
            }
        }

        Dictionary<string, object> body = new Dictionary<string, object>();
        body.Add("shareId", shareId);
        body.Add("status", status);
        body.Add("files", files.ToArray());
        if (unavailable.Count > 0)
        {
            body.Add("unavailable", unavailable.ToArray());
        }
        if (cookie != null)
        {
            body.Add("cookie", cookie);
        }
        return ForwardScanGofile(body);
    }

    /// <summary>
    /// "Scan this video page". The extension read the media URLs from the user's
    /// own rendered tab, which is what a Cloudflare challenge or an age gate
    /// denies the desktop. This only validates the shape and forwards the list;
    /// the desktop re-validates every URL and never solves a challenge itself.
    /// </summary>
    private static Dictionary<string, object> HandleScanVideoMessage(
        Dictionary<string, object> message)
    {
        if (!HasExactKeys(
            message,
            new string[] { "type", "pageUrl", "sources" },
            new string[] { "title", "cookie" }))
        {
            return Error(
                "INVALID_MESSAGE",
                "Only scan-video messages containing type, pageUrl, sources and an optional title or cookie are accepted.");
        }

        string pageUrl;
        string urlError;
        if (!TryNormalizeUrl(message["pageUrl"] as string, out pageUrl, out urlError))
        {
            return Error("INVALID_URL", urlError);
        }

        object[] rawSources = message["sources"] as object[];
        if (rawSources == null || rawSources.Length > MaxScanVideoSources)
        {
            return Error("INVALID_MESSAGE", "The video source list is invalid.");
        }

        List<object> sources = new List<object>();
        for (int index = 0; index < rawSources.Length; index++)
        {
            Dictionary<string, object> raw = rawSources[index] as Dictionary<string, object>;
            if (raw == null ||
                !HasExactKeys(
                    raw,
                    new string[] { "url", "kind" },
                    new string[] { "label", "width", "height", "sizeBytes" }))
            {
                return Error("INVALID_MESSAGE", "A video source is invalid.");
            }

            string sourceUrl;
            if (!TryNormalizeUrl(raw["url"] as string, out sourceUrl, out urlError))
            {
                return Error("INVALID_URL", urlError);
            }

            string kind = raw["kind"] as string;
            if (kind != "file" && kind != "hls" && kind != "dash")
            {
                return Error("INVALID_MESSAGE", "A video source kind is unsupported.");
            }

            Dictionary<string, object> entry = new Dictionary<string, object>();
            entry.Add("url", sourceUrl);
            entry.Add("kind", kind);
            if (raw.ContainsKey("label"))
            {
                if (!IsSafeText(raw["label"], MaxScanVideoLabelLength))
                {
                    return Error("INVALID_MESSAGE", "A video source label is invalid.");
                }
                entry.Add("label", raw["label"] as string);
            }
            foreach (string key in new string[] { "width", "height" })
            {
                if (!raw.ContainsKey(key))
                {
                    continue;
                }
                long dimension;
                if (!TryReadPositiveLong(raw[key], out dimension) ||
                    dimension > MaxScanVideoDimension)
                {
                    return Error("INVALID_MESSAGE", "A video source size is invalid.");
                }
                entry.Add(key, dimension);
            }
            if (raw.ContainsKey("sizeBytes"))
            {
                long bytes;
                if (!TryReadPositiveLong(raw["sizeBytes"], out bytes) ||
                    bytes > MaxScanVideoBytes)
                {
                    return Error("INVALID_MESSAGE", "A video source size is invalid.");
                }
                entry.Add("sizeBytes", bytes);
            }
            sources.Add(entry);
        }

        Dictionary<string, object> body = new Dictionary<string, object>();
        body.Add("pageUrl", pageUrl);
        body.Add("sources", sources.ToArray());
        if (message.ContainsKey("title"))
        {
            if (!IsSafeText(message["title"], MaxScanVideoTitleLength))
            {
                return Error("INVALID_MESSAGE", "The video page title is invalid.");
            }
            body.Add("title", message["title"] as string);
        }
        if (message.ContainsKey("cookie"))
        {
            string cookie = message["cookie"] as string;
            if (!IsSafeHeaderValue(cookie, 8192))
            {
                return Error("INVALID_MESSAGE", "The browser cookie header is invalid.");
            }
            body.Add("cookie", cookie);
        }
        return ForwardScanVideo(body);
    }

    /// <summary>Gofile share ids are short URL-safe tokens, never a path.</summary>
    private static bool IsGofileShareId(string value)
    {
        if (value == null || value.Length < 4 || value.Length > 64)
        {
            return false;
        }
        for (int index = 0; index < value.Length; index++)
        {
            char character = value[index];
            bool allowed =
                (character >= 'a' && character <= 'z') ||
                (character >= 'A' && character <= 'Z') ||
                (character >= '0' && character <= '9') ||
                character == '-' ||
                character == '_';
            if (!allowed)
            {
                return false;
            }
        }
        return true;
    }

    private static bool IsGofileShareStatus(string value)
    {
        return value == "ok" ||
            value == "empty" ||
            value == "not-found" ||
            value == "password" ||
            value == "premium" ||
            value == "timeout";
    }

    /// <summary>gofile.io, www.gofile.io and every store&lt;N&gt;.gofile.io host.</summary>
    private static bool IsGofileHostName(string host)
    {
        if (host == null)
        {
            return false;
        }
        string lowered = host.ToLowerInvariant();
        if (lowered == "gofile.io" || lowered == "www.gofile.io")
        {
            return true;
        }
        return lowered.Length > ".gofile.io".Length &&
            lowered.EndsWith(".gofile.io", StringComparison.Ordinal);
    }

    private static bool IsGofileDownloadUrl(string value)
    {
        Uri uri;
        if (!Uri.TryCreate(value, UriKind.Absolute, out uri))
        {
            return false;
        }
        if (uri.Scheme != Uri.UriSchemeHttps)
        {
            return false;
        }
        if (!string.IsNullOrEmpty(uri.UserInfo))
        {
            return false;
        }
        if (!IsGofileHostName(uri.Host))
        {
            return false;
        }
        return uri.AbsolutePath.StartsWith("/download/", StringComparison.Ordinal);
    }

    private static bool IsSafeHeaderValue(string value, int maximum)
    {
        if (value == null || value.Trim().Length == 0 || value.Length > maximum)
        {
            return false;
        }
        for (int index = 0; index < value.Length; index++)
        {
            char character = value[index];
            if (character < 0x20 || character == 0x7f)
            {
                return false;
            }
        }
        return true;
    }

    private static Dictionary<string, object> HandleHandoffDownloadMessage(
        Dictionary<string, object> message)
    {
        if (!HasExactKeys(
            message,
            new string[] { "type", "url" },
            new string[] { "filename", "expectedBytes", "expectedContentType", "referer", "userAgent", "cookie" }))
        {
            return Error(
                "INVALID_MESSAGE",
                "Only handoff-download messages containing type, url and optional filename/expectedBytes/expectedContentType/referer/userAgent/cookie are accepted.");
        }

        string normalizedUrl;
        string urlError;
        if (!TryNormalizeUrl(message["url"] as string, out normalizedUrl, out urlError))
        {
            return Error("INVALID_URL", urlError);
        }

        string filename = null;
        if (message.ContainsKey("filename"))
        {
            filename = message["filename"] as string;
            if (!IsSafeCapturedFilename(filename))
            {
                return Error("INVALID_MESSAGE", "The hand-off filename is invalid.");
            }
        }

        long expectedBytes = 0;
        if (message.ContainsKey("expectedBytes") &&
            !TryReadPositiveLong(message["expectedBytes"], out expectedBytes))
        {
            return Error("INVALID_MESSAGE", "The hand-off expected size is invalid.");
        }

        string expectedContentType = null;
        if (message.ContainsKey("expectedContentType"))
        {
            expectedContentType = message["expectedContentType"] as string;
            if (expectedContentType == null ||
                !ContentTypePattern.IsMatch(expectedContentType))
            {
                return Error("INVALID_MESSAGE", "The hand-off expected content type is invalid.");
            }
            expectedContentType = expectedContentType.ToLowerInvariant();
        }

        string referer = null;
        if (message.ContainsKey("referer"))
        {
            string urlError2;
            if (!TryNormalizeUrl(message["referer"] as string, out referer, out urlError2) ||
                referer.Length > 4096)
            {
                return Error("INVALID_MESSAGE", "The hand-off referer is invalid.");
            }
        }

        string userAgent = null;
        if (message.ContainsKey("userAgent"))
        {
            userAgent = message["userAgent"] as string;
            if (!IsSafeHeaderValue(userAgent, 512))
            {
                return Error("INVALID_MESSAGE", "The hand-off user agent is invalid.");
            }
        }

        string cookie = null;
        if (message.ContainsKey("cookie"))
        {
            cookie = message["cookie"] as string;
            if (!IsSafeHeaderValue(cookie, 8192))
            {
                return Error("INVALID_MESSAGE", "The browser cookie header is invalid.");
            }
        }

        bool supported = false;
        try
        {
            string absolutePath = new Uri(normalizedUrl).AbsolutePath;
            // The browser already decided this is a download. Anything that is
            // not an HTML page, playlist or segment may be taken over; a known
            // supported container or media file is accepted explicitly.
            supported = !HandoffPageOrManifestExtensionPattern.IsMatch(absolutePath);
        }
        catch (Exception)
        {
            return Error("INVALID_URL", "That does not look like a valid URL.");
        }
        if (supported && filename != null && HandoffPageOrManifestExtensionPattern.IsMatch(filename))
        {
            supported = false;
        }
        if (supported && expectedContentType != null &&
            HandoffPageOrManifestContentTypePattern.IsMatch(expectedContentType))
        {
            supported = false;
        }
        if (!supported && filename != null)
        {
            supported = HandoffExtensionPattern.IsMatch(filename);
        }
        if (!supported)
        {
            return Error(
                "HANDOFF_UNSUPPORTED_FILE",
                "HTML pages, playlists and stream segments stay in the browser.");
        }

        Dictionary<string, object> body = new Dictionary<string, object>();
        body.Add("url", normalizedUrl);
        if (filename != null)
        {
            body.Add("filename", filename);
        }
        if (message.ContainsKey("expectedBytes"))
        {
            body.Add("expectedBytes", expectedBytes);
        }
        if (expectedContentType != null)
        {
            body.Add("expectedContentType", expectedContentType);
        }
        if (referer != null)
        {
            body.Add("referer", referer);
        }
        if (userAgent != null)
        {
            body.Add("userAgent", userAgent);
        }
        if (cookie != null)
        {
            body.Add("cookie", cookie);
        }
        return ForwardHandoff(body);
    }

    /// <summary>
    /// Read-only progress for the one download the extension took over. The
    /// message carries exactly the operation and the desktop download id; no
    /// URL, path, cookie or header is accepted or returned.
    /// </summary>
    private static Dictionary<string, object> HandleDownloadStatusMessage(
        Dictionary<string, object> message)
    {
        if (!HasExactKeys(message, new string[] { "type", "downloadId" }, new string[0]))
        {
            return Error(
                "INVALID_MESSAGE",
                "Only download-status messages containing exactly type and downloadId are accepted.");
        }
        string downloadId = message["downloadId"] as string;
        if (downloadId == null || !DownloadIdPattern.IsMatch(downloadId))
        {
            return Error("INVALID_MESSAGE", "The download identifier is invalid.");
        }

        Dictionary<string, object> body = new Dictionary<string, object>();
        body.Add("downloadId", downloadId);
        return ForwardDownloadStatus(body);
    }

    /// <summary>
    /// Focus the desktop and reveal that download row. Only the validated
    /// desktop download id crosses the bridge.
    /// </summary>
    private static Dictionary<string, object> HandleShowDownloadMessage(
        Dictionary<string, object> message)
    {
        if (!HasExactKeys(message, new string[] { "type", "downloadId" }, new string[0]))
        {
            return Error(
                "INVALID_MESSAGE",
                "Only show-download messages containing exactly type and downloadId are accepted.");
        }
        string downloadId = message["downloadId"] as string;
        if (downloadId == null || !DownloadIdPattern.IsMatch(downloadId))
        {
            return Error("INVALID_MESSAGE", "The download identifier is invalid.");
        }

        Dictionary<string, object> body = new Dictionary<string, object>();
        body.Add("downloadId", downloadId);
        return ForwardShowDownload(body);
    }

    private static bool TryReadPositiveLong(object value, out long result)
    {
        result = 0;
        if (value == null)
        {
            return false;
        }
        if (!(value is int || value is long || value is decimal || value is double))
        {
            return false;
        }
        if (value is double)
        {
            double doubleValue = (double)value;
            if (doubleValue != Math.Truncate(doubleValue))
            {
                return false;
            }
        }
        try
        {
            result = Convert.ToInt64(value, CultureInfo.InvariantCulture);
        }
        catch (Exception)
        {
            return false;
        }
        return result > 0;
    }

    private static bool IsSafeCapturedFilename(string filename)
    {
        if (filename == null)
        {
            return false;
        }
        string trimmed = filename.Trim();
        if (trimmed.Length == 0 || filename.Length > 180)
        {
            return false;
        }
        if (trimmed == "." || trimmed == "..")
        {
            return false;
        }
        for (int index = 0; index < filename.Length; index++)
        {
            char character = filename[index];
            if (character < 0x20 || character == 0x7f ||
                character == '/' || character == '\\')
            {
                return false;
            }
        }
        return true;
    }

    private static Dictionary<string, object> HandleMediaJobMessage(
        Dictionary<string, object> message,
        string operation)
    {
        if (!HasExactKeys(message, new string[] { "type", "jobId" }, new string[0]))
        {
            return Error(
                "INVALID_MESSAGE",
                "Only media-status and cancel-media messages containing exactly type and jobId are accepted.");
        }
        if (!IsOpaqueMediaId(message["jobId"]))
        {
            return Error("INVALID_MESSAGE", "The media job identifier is invalid.");
        }

        Dictionary<string, object> body = new Dictionary<string, object>();
        body.Add("jobId", (string)message["jobId"]);

        string route = operation == MediaStatusOperation ? "/media-status" : "/cancel-media";
        return ForwardMedia(operation, route, body);
    }

    private static bool HasExactKeys(
        Dictionary<string, object> message,
        string[] required,
        string[] optional)
    {
        if (message.Count > required.Length + optional.Length)
        {
            return false;
        }
        for (int index = 0; index < required.Length; index++)
        {
            if (!message.ContainsKey(required[index]))
            {
                return false;
            }
        }
        foreach (string key in message.Keys)
        {
            if (Array.IndexOf(required, key) < 0 && Array.IndexOf(optional, key) < 0)
            {
                return false;
            }
        }
        return true;
    }

    private static bool IsOpaqueMediaId(object value)
    {
        string text = value as string;
        return text != null && OpaqueMediaIdPattern.IsMatch(text);
    }

    private static Dictionary<string, object> QueueDownload(string url, bool force)
    {
        BridgeState state;
        string stateError;
        if (!TryLoadBridgeState(out state, out stateError))
        {
            return Error("APP_NOT_RUNNING", stateError);
        }

        HttpWebRequest request = null;
        try
        {
            request = CreateBridgeRequest(
                state,
                "/queue-download",
                BridgeTimeoutMilliseconds);

            Dictionary<string, object> body = new Dictionary<string, object>();
            body.Add("url", url);
            if (force)
            {
                // The only extra protocol field: an explicit user-initiated
                // second copy. There are still no commands, paths or names.
                body.Add("force", true);
            }
            byte[] payload = Encoding.UTF8.GetBytes(Serializer.Serialize(body));
            request.ContentLength = payload.Length;

            using (Stream stream = request.GetRequestStream())
            {
                stream.Write(payload, 0, payload.Length);
            }
        }
        catch (WebException)
        {
            return Error(
                "APP_NOT_RUNNING",
                "DonDownload is not running or its browser bridge is unavailable. Start DonDownload and try again.");
        }
        catch (InvalidOperationException)
        {
            return Error("APP_NOT_RUNNING", "DonDownload's browser bridge is unavailable. Restart DonDownload.");
        }
        catch (Exception)
        {
            return Error(
                "APP_NOT_RUNNING",
                "DonDownload is not running or its browser bridge is unavailable. Start DonDownload and try again.");
        }

        HttpWebResponse response = null;
        try
        {
            response = (HttpWebResponse)request.GetResponse();
        }
        catch (WebException error)
        {
            response = error.Response as HttpWebResponse;
            if (response == null)
            {
                return Error(
                    "APP_NOT_RUNNING",
                    "DonDownload is not running or its browser bridge is unavailable. Start DonDownload and try again.");
            }
        }
        catch (Exception)
        {
            return Error(
                "APP_NOT_RUNNING",
                "DonDownload is not running or its browser bridge is unavailable. Start DonDownload and try again.");
        }

        using (response)
        {
            string responseText;
            try
            {
                responseText = ReadBounded(response.GetResponseStream(), MaxResponseBytes);
            }
            catch (Exception)
            {
                return Error("APP_RESPONSE_INVALID", "DonDownload returned an unreadable response.");
            }

            return ParseAppResponse(responseText);
        }
    }

    private static Dictionary<string, object> ParseAppResponse(string responseText)
    {
        object parsed;
        try
        {
            parsed = Serializer.DeserializeObject(responseText);
        }
        catch (Exception)
        {
            return Error("APP_RESPONSE_INVALID", "DonDownload returned an invalid response.");
        }

        Dictionary<string, object> response = parsed as Dictionary<string, object>;
        if (response == null || !response.ContainsKey("ok"))
        {
            return Error("APP_RESPONSE_INVALID", "DonDownload returned an unexpected response.");
        }

        object okValue = response["ok"];
        if (okValue is bool && (bool)okValue)
        {
            Dictionary<string, object> success = new Dictionary<string, object>();
            success.Add("ok", true);
            success.Add("accepted", true);
            return success;
        }

        Dictionary<string, object> error = response.ContainsKey("error")
            ? response["error"] as Dictionary<string, object>
            : null;
        if (error == null ||
            !(error.ContainsKey("code") && error["code"] is string) ||
            !(error.ContainsKey("message") && error["message"] is string))
        {
            return Error("APP_REJECTED", "DonDownload rejected the request.");
        }

        return Error((string)error["code"], (string)error["message"]);
    }

    // The host talks to exactly one loopback endpoint for its whole lifetime, so
    // one shared connection pool is enough. Keeping the connection alive avoids
    // a fresh TCP handshake for every message the browser sends.
    private static readonly object BridgeServicePointLock = new object();
    private static ServicePoint bridgeServicePoint;
    private static int bridgeServicePointPort = -1;

    private static void ConfigureBridgeServicePoint(HttpWebRequest request, int port)
    {
        request.ServicePoint.Expect100Continue = false;
        lock (BridgeServicePointLock)
        {
            if (bridgeServicePointPort == port && bridgeServicePoint != null)
            {
                return;
            }
            bridgeServicePoint = request.ServicePoint;
            bridgeServicePointPort = port;
            // A handful of concurrent requests at most; the desktop bridge is
            // local, so a small pool is plenty.
            bridgeServicePoint.ConnectionLimit = 4;
            // Stay below the loopback server's 30s keep-alive timeout so this
            // side never reuses a connection the server has already closed.
            bridgeServicePoint.MaxIdleTime = 20000;
        }
    }

    private static HttpWebRequest CreateBridgeRequest(
        BridgeState state,
        string route,
        int timeoutMilliseconds)
    {
        HttpWebRequest request = (HttpWebRequest)WebRequest.Create(
            "http://127.0.0.1:" + state.Port.ToString(CultureInfo.InvariantCulture) + route);
        request.Method = "POST";
        request.ContentType = "application/json; charset=utf-8";
        request.Accept = "application/json";
        request.Headers[HttpRequestHeader.Authorization] = "Bearer " + state.Token;
        request.AllowAutoRedirect = false;
        request.Proxy = null;
        request.KeepAlive = true;
        request.Timeout = timeoutMilliseconds;
        request.ReadWriteTimeout = timeoutMilliseconds;
        request.UserAgent = "DonDownload-Native/0.1.0";
        ConfigureBridgeServicePoint(request, state.Port);
        return request;
    }

    private static Dictionary<string, object> ForwardMedia(
        string operation,
        string route,
        Dictionary<string, object> body)
    {
        BridgeState state;
        string stateError;
        if (!TryLoadBridgeState(out state, out stateError))
        {
            return Error("APP_NOT_RUNNING", stateError);
        }

        HttpWebRequest request = null;
        try
        {
            request = CreateBridgeRequest(
                state,
                route,
                operation == AnalyzeMediaOperation
                    ? AnalyzeMediaTimeoutMilliseconds
                    : BridgeTimeoutMilliseconds);
            byte[] payload = Encoding.UTF8.GetBytes(Serializer.Serialize(body));
            request.ContentLength = payload.Length;
            using (Stream stream = request.GetRequestStream())
            {
                stream.Write(payload, 0, payload.Length);
            }
        }
        catch (WebException)
        {
            return Error(
                "APP_NOT_RUNNING",
                "DonDownload is not running or its browser bridge is unavailable. Start DonDownload and try again.");
        }
        catch (InvalidOperationException)
        {
            return Error("APP_NOT_RUNNING", "DonDownload's browser bridge is unavailable. Restart DonDownload.");
        }
        catch (Exception)
        {
            return Error(
                "APP_NOT_RUNNING",
                "DonDownload is not running or its browser bridge is unavailable. Start DonDownload and try again.");
        }

        HttpWebResponse response = null;
        try
        {
            response = (HttpWebResponse)request.GetResponse();
        }
        catch (WebException error)
        {
            response = error.Response as HttpWebResponse;
            if (response == null)
            {
                return Error(
                    "APP_NOT_RUNNING",
                    "DonDownload is not running or its browser bridge is unavailable. Start DonDownload and try again.");
            }
        }
        catch (Exception)
        {
            return Error(
                "APP_NOT_RUNNING",
                "DonDownload is not running or its browser bridge is unavailable. Start DonDownload and try again.");
        }

        using (response)
        {
            string responseText;
            try
            {
                responseText = ReadBounded(response.GetResponseStream(), MaxResponseBytes);
            }
            catch (Exception)
            {
                return Error("APP_RESPONSE_INVALID", "DonDownload returned an unreadable response.");
            }

            return ParseMediaAppResponse(responseText, operation);
        }
    }

    private static Dictionary<string, object> ForwardCapturedSource(
        Dictionary<string, object> body)
    {
        BridgeState state;
        string stateError;
        if (!TryLoadBridgeState(out state, out stateError))
        {
            return Error("APP_NOT_RUNNING", stateError);
        }

        HttpWebRequest request = null;
        try
        {
            request = CreateBridgeRequest(
                state,
                "/queue-captured-source",
                BridgeTimeoutMilliseconds);
            byte[] payload = Encoding.UTF8.GetBytes(Serializer.Serialize(body));
            request.ContentLength = payload.Length;
            using (Stream stream = request.GetRequestStream())
            {
                stream.Write(payload, 0, payload.Length);
            }
        }
        catch (WebException)
        {
            return Error(
                "APP_NOT_RUNNING",
                "DonDownload is not running or its browser bridge is unavailable. Start DonDownload and try again.");
        }
        catch (InvalidOperationException)
        {
            return Error("APP_NOT_RUNNING", "DonDownload's browser bridge is unavailable. Restart DonDownload.");
        }
        catch (Exception)
        {
            return Error(
                "APP_NOT_RUNNING",
                "DonDownload is not running or its browser bridge is unavailable. Start DonDownload and try again.");
        }

        HttpWebResponse response = null;
        try
        {
            response = (HttpWebResponse)request.GetResponse();
        }
        catch (WebException error)
        {
            response = error.Response as HttpWebResponse;
            if (response == null)
            {
                return Error(
                    "APP_NOT_RUNNING",
                    "DonDownload is not running or its browser bridge is unavailable. Start DonDownload and try again.");
            }
        }
        catch (Exception)
        {
            return Error(
                "APP_NOT_RUNNING",
                "DonDownload is not running or its browser bridge is unavailable. Start DonDownload and try again.");
        }

        using (response)
        {
            string responseText;
            try
            {
                responseText = ReadBounded(response.GetResponseStream(), MaxResponseBytes);
            }
            catch (Exception)
            {
                return Error("APP_RESPONSE_INVALID", "DonDownload returned an unreadable response.");
            }

            return ParseAppResponse(responseText);
        }
    }

    private static Dictionary<string, object> ForwardSniffedMedia(
        Dictionary<string, object> body)
    {
        BridgeState state;
        string stateError;
        if (!TryLoadBridgeState(out state, out stateError))
        {
            return Error("APP_NOT_RUNNING", stateError);
        }

        HttpWebRequest request = null;
        try
        {
            request = CreateBridgeRequest(
                state,
                "/queue-sniffed-media",
                BridgeTimeoutMilliseconds);
            byte[] payload = Encoding.UTF8.GetBytes(Serializer.Serialize(body));
            request.ContentLength = payload.Length;
            using (Stream stream = request.GetRequestStream())
            {
                stream.Write(payload, 0, payload.Length);
            }
        }
        catch (WebException)
        {
            return Error(
                "APP_NOT_RUNNING",
                "DonDownload is not running or its browser bridge is unavailable. Start DonDownload and try again.");
        }
        catch (InvalidOperationException)
        {
            return Error("APP_NOT_RUNNING", "DonDownload's browser bridge is unavailable. Restart DonDownload.");
        }
        catch (Exception)
        {
            return Error(
                "APP_NOT_RUNNING",
                "DonDownload is not running or its browser bridge is unavailable. Start DonDownload and try again.");
        }

        HttpWebResponse response = null;
        try
        {
            response = (HttpWebResponse)request.GetResponse();
        }
        catch (WebException error)
        {
            response = error.Response as HttpWebResponse;
            if (response == null)
            {
                return Error(
                    "APP_NOT_RUNNING",
                    "DonDownload is not running or its browser bridge is unavailable. Start DonDownload and try again.");
            }
        }
        catch (Exception)
        {
            return Error(
                "APP_NOT_RUNNING",
                "DonDownload is not running or its browser bridge is unavailable. Start DonDownload and try again.");
        }

        using (response)
        {
            string responseText;
            try
            {
                responseText = ReadBounded(response.GetResponseStream(), MaxResponseBytes);
            }
            catch (Exception)
            {
                return Error("APP_RESPONSE_INVALID", "DonDownload returned an unreadable response.");
            }

            return ParseAppResponse(responseText);
        }
    }

    private static Dictionary<string, object> ForwardScanPage(
        Dictionary<string, object> body)
    {
        return ForwardScanRoute(body, "/scan-page");
    }

    /// <summary>
    /// POST one validated image list to the desktop /scan-images route. The
    /// desktop re-validates every URL and opens the picker; nothing is queued
    /// from here.
    /// </summary>
    private static Dictionary<string, object> ForwardScanImages(
        Dictionary<string, object> body)
    {
        return ForwardScanRoute(body, "/scan-images");
    }

    /// <summary>
    /// POST one validated Gofile share to the desktop /scan-gofile route. The
    /// rows came from the user's own signed-in tab, so the desktop never fetches
    /// Gofile itself and nothing is queued from here.
    /// </summary>
    private static Dictionary<string, object> ForwardScanGofile(
        Dictionary<string, object> body)
    {
        return ForwardScanRoute(body, "/scan-gofile");
    }

    /// <summary>
    /// POST one validated video page to the desktop /scan-video route. The
    /// media URLs came from the user's own rendered tab, so the desktop never
    /// fetches the page and nothing is queued from here.
    /// </summary>
    private static Dictionary<string, object> ForwardScanVideo(
        Dictionary<string, object> body)
    {
        return ForwardScanRoute(body, "/scan-video");
    }

    /// <summary>
    /// POST one already validated scan body to its desktop route. Every scan
    /// operation shares this transport: load the bridge endpoint, send the exact
    /// validated fields with the bearer token, and parse the bounded answer.
    /// </summary>
    private static Dictionary<string, object> ForwardScanRoute(
        Dictionary<string, object> body,
        string route)
    {
        BridgeState state;
        string stateError;
        if (!TryLoadBridgeState(out state, out stateError))
        {
            return Error("APP_NOT_RUNNING", stateError);
        }

        HttpWebRequest request = null;
        try
        {
            request = CreateBridgeRequest(
                state,
                route,
                BridgeTimeoutMilliseconds);
            byte[] payload = Encoding.UTF8.GetBytes(Serializer.Serialize(body));
            request.ContentLength = payload.Length;
            using (Stream stream = request.GetRequestStream())
            {
                stream.Write(payload, 0, payload.Length);
            }
        }
        catch (WebException)
        {
            return Error(
                "APP_NOT_RUNNING",
                "DonDownload is not running or its browser bridge is unavailable. Start DonDownload and try again.");
        }
        catch (InvalidOperationException)
        {
            return Error("APP_NOT_RUNNING", "DonDownload's browser bridge is unavailable. Restart DonDownload.");
        }
        catch (Exception)
        {
            return Error(
                "APP_NOT_RUNNING",
                "DonDownload is not running or its browser bridge is unavailable. Start DonDownload and try again.");
        }

        HttpWebResponse response = null;
        try
        {
            response = (HttpWebResponse)request.GetResponse();
        }
        catch (WebException error)
        {
            response = error.Response as HttpWebResponse;
            if (response == null)
            {
                return Error(
                    "APP_NOT_RUNNING",
                    "DonDownload is not running or its browser bridge is unavailable. Start DonDownload and try again.");
            }
        }
        catch (Exception)
        {
            return Error(
                "APP_NOT_RUNNING",
                "DonDownload is not running or its browser bridge is unavailable. Start DonDownload and try again.");
        }

        using (response)
        {
            string responseText;
            try
            {
                responseText = ReadBounded(response.GetResponseStream(), MaxResponseBytes);
            }
            catch (Exception)
            {
                return Error("APP_RESPONSE_INVALID", "DonDownload returned an unreadable response.");
            }

            return ParseAppResponse(responseText);
        }
    }

    private static Dictionary<string, object> ForwardHandoff(
        Dictionary<string, object> body)
    {
        BridgeState state;
        string stateError;
        if (!TryLoadBridgeState(out state, out stateError))
        {
            return Error("APP_NOT_RUNNING", stateError);
        }

        HttpWebRequest request = null;
        try
        {
            request = CreateBridgeRequest(
                state,
                "/handoff-download",
                BridgeTimeoutMilliseconds);
            byte[] payload = Encoding.UTF8.GetBytes(Serializer.Serialize(body));
            request.ContentLength = payload.Length;
            using (Stream stream = request.GetRequestStream())
            {
                stream.Write(payload, 0, payload.Length);
            }
        }
        catch (WebException)
        {
            return Error(
                "APP_NOT_RUNNING",
                "DonDownload is not running or its browser bridge is unavailable. Start DonDownload and try again.");
        }
        catch (InvalidOperationException)
        {
            return Error("APP_NOT_RUNNING", "DonDownload's browser bridge is unavailable. Restart DonDownload.");
        }
        catch (Exception)
        {
            return Error(
                "APP_NOT_RUNNING",
                "DonDownload is not running or its browser bridge is unavailable. Start DonDownload and try again.");
        }

        HttpWebResponse response = null;
        try
        {
            response = (HttpWebResponse)request.GetResponse();
        }
        catch (WebException error)
        {
            response = error.Response as HttpWebResponse;
            if (response == null)
            {
                return Error(
                    "APP_NOT_RUNNING",
                    "DonDownload is not running or its browser bridge is unavailable. Start DonDownload and try again.");
            }
        }
        catch (Exception)
        {
            return Error(
                "APP_NOT_RUNNING",
                "DonDownload is not running or its browser bridge is unavailable. Start DonDownload and try again.");
        }

        using (response)
        {
            string responseText;
            try
            {
                responseText = ReadBounded(response.GetResponseStream(), MaxResponseBytes);
            }
            catch (Exception)
            {
                return Error("APP_RESPONSE_INVALID", "DonDownload returned an unreadable response.");
            }

            return ParseDurableHandoffAppResponse(responseText);
        }
    }

    private static Dictionary<string, object> ParseDurableHandoffAppResponse(
        string responseText)
    {
        object parsed;
        try
        {
            parsed = Serializer.DeserializeObject(responseText);
        }
        catch (Exception)
        {
            return Error("APP_RESPONSE_INVALID", "DonDownload returned an invalid response.");
        }

        Dictionary<string, object> response = parsed as Dictionary<string, object>;
        if (response == null || !response.ContainsKey("ok"))
        {
            return Error("APP_RESPONSE_INVALID", "DonDownload returned an unexpected response.");
        }

        object okValue = response["ok"];
        if (okValue is bool && (bool)okValue)
        {
            if (!HasExactKeys(
                response,
                new string[] { "ok", "accepted", "operation", "durable", "receipt" },
                new string[0]))
            {
                return Error("APP_RESPONSE_INVALID", "DonDownload returned an unexpected response.");
            }
            if (!(response["accepted"] is bool) || !((bool)response["accepted"]))
            {
                return Error("APP_RESPONSE_INVALID", "DonDownload did not accept the hand-off.");
            }
            if (!(response["durable"] is bool) || !((bool)response["durable"]))
            {
                return Error("APP_RESPONSE_INVALID", "DonDownload did not confirm durable storage.");
            }
            if ((response["operation"] as string) != HandoffDownloadOperation)
            {
                return Error("APP_RESPONSE_INVALID", "DonDownload returned a mismatched response.");
            }

            Dictionary<string, object> receipt =
                response["receipt"] as Dictionary<string, object>;
            if (receipt == null ||
                !HasExactKeys(receipt, new string[] { "downloadId", "persistedAt" }, new string[0]))
            {
                return Error("APP_RESPONSE_INVALID", "DonDownload returned an invalid receipt.");
            }
            string downloadId = receipt["downloadId"] as string;
            if (downloadId == null || !DownloadIdPattern.IsMatch(downloadId))
            {
                return Error("APP_RESPONSE_INVALID", "DonDownload returned an invalid receipt.");
            }
            long persistedAt;
            try
            {
                persistedAt = Convert.ToInt64(receipt["persistedAt"], CultureInfo.InvariantCulture);
            }
            catch (Exception)
            {
                return Error("APP_RESPONSE_INVALID", "DonDownload returned an invalid receipt.");
            }
            if (persistedAt <= 0)
            {
                return Error("APP_RESPONSE_INVALID", "DonDownload returned an invalid receipt.");
            }

            return response;
        }

        if (!(okValue is bool))
        {
            return Error("APP_RESPONSE_INVALID", "DonDownload returned an unexpected response.");
        }

        return ParseAppResponse(responseText);
    }

    /// <summary>
    /// POST one already validated body to the desktop bridge and return the raw
    /// response text. A null return means success; otherwise the returned
    /// dictionary is the error to answer with. Diagnostics never include the
    /// body.
    /// </summary>
    private static Dictionary<string, object> PostToBridge(
        string route,
        Dictionary<string, object> body,
        out string responseText)
    {
        responseText = null;
        BridgeState state;
        string stateError;
        if (!TryLoadBridgeState(out state, out stateError))
        {
            return Error("APP_NOT_RUNNING", stateError);
        }

        HttpWebRequest request = null;
        try
        {
            request = CreateBridgeRequest(state, route, BridgeTimeoutMilliseconds);
            byte[] payload = Encoding.UTF8.GetBytes(Serializer.Serialize(body));
            request.ContentLength = payload.Length;
            using (Stream stream = request.GetRequestStream())
            {
                stream.Write(payload, 0, payload.Length);
            }
        }
        catch (WebException)
        {
            return Error(
                "APP_NOT_RUNNING",
                "DonDownload is not running or its browser bridge is unavailable. Start DonDownload and try again.");
        }
        catch (InvalidOperationException)
        {
            return Error("APP_NOT_RUNNING", "DonDownload's browser bridge is unavailable. Restart DonDownload.");
        }
        catch (Exception)
        {
            return Error(
                "APP_NOT_RUNNING",
                "DonDownload is not running or its browser bridge is unavailable. Start DonDownload and try again.");
        }

        HttpWebResponse response = null;
        try
        {
            response = (HttpWebResponse)request.GetResponse();
        }
        catch (WebException error)
        {
            response = error.Response as HttpWebResponse;
            if (response == null)
            {
                return Error(
                    "APP_NOT_RUNNING",
                    "DonDownload is not running or its browser bridge is unavailable. Start DonDownload and try again.");
            }
        }
        catch (Exception)
        {
            return Error(
                "APP_NOT_RUNNING",
                "DonDownload is not running or its browser bridge is unavailable. Start DonDownload and try again.");
        }

        using (response)
        {
            try
            {
                responseText = ReadBounded(response.GetResponseStream(), MaxResponseBytes);
            }
            catch (Exception)
            {
                return Error("APP_RESPONSE_INVALID", "DonDownload returned an unreadable response.");
            }
        }
        return null;
    }

    private static Dictionary<string, object> ForwardDownloadStatus(
        Dictionary<string, object> body)
    {
        string responseText;
        Dictionary<string, object> failure = PostToBridge("/download-status", body, out responseText);
        if (failure != null)
        {
            return failure;
        }
        return ParseDownloadStatusAppResponse(responseText);
    }

    private static Dictionary<string, object> ForwardShowDownload(
        Dictionary<string, object> body)
    {
        string responseText;
        Dictionary<string, object> failure = PostToBridge("/show-download", body, out responseText);
        if (failure != null)
        {
            return failure;
        }
        return ParseShowDownloadAppResponse(responseText);
    }

    /// <summary>
    /// Re-validate the desktop's progress answer and re-emit only the five
    /// browser-facing fields. A URL, path or header can therefore never reach a
    /// page even if the desktop one day returned one.
    /// </summary>
    private static Dictionary<string, object> ParseDownloadStatusAppResponse(
        string responseText)
    {
        object parsed;
        try
        {
            parsed = Serializer.DeserializeObject(responseText);
        }
        catch (Exception)
        {
            return Error("APP_RESPONSE_INVALID", "DonDownload returned an invalid response.");
        }

        Dictionary<string, object> response = parsed as Dictionary<string, object>;
        if (response == null || !response.ContainsKey("ok"))
        {
            return Error("APP_RESPONSE_INVALID", "DonDownload returned an unexpected response.");
        }

        object okValue = response["ok"];
        if (!(okValue is bool) || !((bool)okValue))
        {
            return ParseAppResponse(responseText);
        }

        if (!HasExactKeys(
            response,
            new string[] { "ok", "operation", "status", "completedBytes", "totalBytes", "filename" },
            new string[] { "errorMessage" }))
        {
            return Error("APP_RESPONSE_INVALID", "DonDownload returned an unexpected response.");
        }
        if ((response["operation"] as string) != DownloadStatusOperation)
        {
            return Error("APP_RESPONSE_INVALID", "DonDownload returned a mismatched response.");
        }

        string status = response["status"] as string;
        if (status == null || Array.IndexOf(HandoffDownloadStatuses, status) < 0)
        {
            return Error("APP_RESPONSE_INVALID", "DonDownload returned an unknown download status.");
        }

        long completedBytes;
        long totalBytes;
        if (!TryReadNonNegativeLong(response["completedBytes"], out completedBytes) ||
            !TryReadNonNegativeLong(response["totalBytes"], out totalBytes))
        {
            return Error("APP_RESPONSE_INVALID", "DonDownload returned invalid download byte counts.");
        }

        string filename = response["filename"] as string;
        if (!IsSafeDownloadFilename(filename))
        {
            return Error("APP_RESPONSE_INVALID", "DonDownload returned an invalid file name.");
        }

        Dictionary<string, object> result = new Dictionary<string, object>();
        result.Add("ok", true);
        result.Add("status", status);
        result.Add("completedBytes", completedBytes);
        result.Add("totalBytes", totalBytes);
        result.Add("filename", filename);
        if (response.ContainsKey("errorMessage"))
        {
            string errorMessage = response["errorMessage"] as string;
            if (errorMessage != null && IsSafeErrorMessage(errorMessage))
            {
                result.Add("errorMessage", errorMessage);
            }
        }
        return result;
    }

    private static Dictionary<string, object> ParseShowDownloadAppResponse(
        string responseText)
    {
        object parsed;
        try
        {
            parsed = Serializer.DeserializeObject(responseText);
        }
        catch (Exception)
        {
            return Error("APP_RESPONSE_INVALID", "DonDownload returned an invalid response.");
        }

        Dictionary<string, object> response = parsed as Dictionary<string, object>;
        if (response == null || !response.ContainsKey("ok"))
        {
            return Error("APP_RESPONSE_INVALID", "DonDownload returned an unexpected response.");
        }

        object okValue = response["ok"];
        if (!(okValue is bool) || !((bool)okValue))
        {
            return ParseAppResponse(responseText);
        }

        if (!HasExactKeys(
            response,
            new string[] { "ok", "operation", "shown" },
            new string[0]))
        {
            return Error("APP_RESPONSE_INVALID", "DonDownload returned an unexpected response.");
        }
        if ((response["operation"] as string) != ShowDownloadOperation)
        {
            return Error("APP_RESPONSE_INVALID", "DonDownload returned a mismatched response.");
        }
        if (!(response["shown"] is bool) || !((bool)response["shown"]))
        {
            return Error("APP_RESPONSE_INVALID", "DonDownload did not show the download.");
        }

        Dictionary<string, object> result = new Dictionary<string, object>();
        result.Add("ok", true);
        result.Add("shown", true);
        return result;
    }

    private static bool TryReadNonNegativeLong(object value, out long result)
    {
        result = 0;
        if (!TryGetLong(value, out result))
        {
            return false;
        }
        return result >= 0;
    }

    /// <summary>
    /// A display-only file name: no directory part, no control characters and
    /// a bounded length. The card only ever assigns it with textContent.
    /// </summary>
    private static bool IsSafeDownloadFilename(string filename)
    {
        if (!IsSafeText(filename, 180))
        {
            return false;
        }
        return filename.IndexOf('/') < 0 && filename.IndexOf('\\') < 0;
    }

    private static Dictionary<string, object> ParseMediaAppResponse(
        string responseText,
        string operation)
    {
        object parsed;
        try
        {
            parsed = Serializer.DeserializeObject(responseText);
        }
        catch (Exception)
        {
            return Error("APP_RESPONSE_INVALID", "DonDownload returned an invalid response.");
        }

        Dictionary<string, object> response = parsed as Dictionary<string, object>;
        if (response == null || !response.ContainsKey("ok"))
        {
            return Error("APP_RESPONSE_INVALID", "DonDownload returned an unexpected response.");
        }

        object okValue = response["ok"];
        if (okValue is bool && (bool)okValue)
        {
            string payloadKey = operation == AnalyzeMediaOperation ? "analysis" : "job";
            if (!HasExactKeys(
                response,
                new string[] { "ok", "operation", payloadKey },
                new string[0]))
            {
                return Error("APP_RESPONSE_INVALID", "DonDownload returned an unexpected response.");
            }
            if ((response["operation"] as string) != operation)
            {
                return Error("APP_RESPONSE_INVALID", "DonDownload returned a mismatched response.");
            }

            bool valid = operation == AnalyzeMediaOperation
                ? ValidateMediaAnalysis(response[payloadKey])
                : ValidateMediaJob(response[payloadKey]);
            if (!valid)
            {
                return Error("APP_RESPONSE_INVALID", "DonDownload returned an invalid media response.");
            }
            return response;
        }

        if (!(okValue is bool))
        {
            return Error("APP_RESPONSE_INVALID", "DonDownload returned an unexpected response.");
        }

        if (!HasExactKeys(response, new string[] { "ok", "error" }, new string[0]))
        {
            return Error("APP_RESPONSE_INVALID", "DonDownload returned an unexpected response.");
        }

        Dictionary<string, object> error = response["error"] as Dictionary<string, object>;
        if (error == null ||
            !HasExactKeys(error, new string[] { "code", "message" }, new string[0]))
        {
            return Error("APP_REJECTED", "DonDownload rejected the request.");
        }

        string code = error["code"] as string;
        string message = error["message"] as string;
        if (code == null || !ErrorCodePattern.IsMatch(code) || !IsSafeErrorMessage(message))
        {
            return Error("APP_REJECTED", "DonDownload rejected the request.");
        }

        return Error(code, message);
    }

    private static bool IsSafeErrorMessage(string message)
    {
        if (message == null || message.Trim().Length == 0 || message.Length > 2000)
        {
            return false;
        }
        for (int index = 0; index < message.Length; index++)
        {
            char character = message[index];
            if (character < 0x20 || character == 0x7f)
            {
                return false;
            }
        }
        if (Regex.IsMatch(message, "://", RegexOptions.CultureInvariant))
        {
            return false;
        }
        if (Regex.IsMatch(message, "[A-Za-z]:\\\\", RegexOptions.CultureInvariant))
        {
            return false;
        }
        return true;
    }

    private static bool ValidateMediaAnalysis(object value)
    {
        Dictionary<string, object> record = value as Dictionary<string, object>;
        if (record == null ||
            !HasExactKeys(
                record,
                new string[]
                {
                    "analysisId",
                    "title",
                    "durationSeconds",
                    "options",
                    "bestVideoOptionId",
                    "bestAudioOptionId",
                    "expiresAt"
                },
                new string[] { "thumbnailUrl" }))
        {
            return false;
        }

        if (!IsOpaqueMediaId(record["analysisId"]) ||
            !IsSafeText(record["title"], 500))
        {
            return false;
        }
        if (record.ContainsKey("thumbnailUrl") && record["thumbnailUrl"] != null)
        {
            Uri thumbnail;
            if (!Uri.TryCreate(record["thumbnailUrl"] as string, UriKind.Absolute, out thumbnail) ||
                thumbnail.Scheme != Uri.UriSchemeHttps ||
                !String.IsNullOrEmpty(thumbnail.UserInfo) ||
                ((string)record["thumbnailUrl"]).Length > 2048 ||
                String.IsNullOrEmpty(thumbnail.Host))
            {
                return false;
            }
        }

        if (record["durationSeconds"] != null)
        {
            double duration;
            if (!TryGetDouble(record["durationSeconds"], out duration) || duration < 0)
            {
                return false;
            }
        }

        object[] options = record["options"] as object[];
        if (options == null || options.Length > 200)
        {
            return false;
        }

        Dictionary<string, string> kinds = new Dictionary<string, string>();
        for (int index = 0; index < options.Length; index++)
        {
            string optionId;
            string kind;
            if (!ValidateMediaOption(options[index], out optionId, out kind))
            {
                return false;
            }
            if (kinds.ContainsKey(optionId))
            {
                return false;
            }
            kinds.Add(optionId, kind);
        }

        if (record["bestVideoOptionId"] != null &&
            !ReferencesMediaKind(record["bestVideoOptionId"], kinds, "video"))
        {
            return false;
        }
        if (record["bestAudioOptionId"] != null &&
            !ReferencesMediaKind(record["bestAudioOptionId"], kinds, "audio"))
        {
            return false;
        }

        long expiresAt;
        return TryGetLong(record["expiresAt"], out expiresAt) && expiresAt >= 1;
    }

    private static bool ValidateMediaOption(
        object value,
        out string optionId,
        out string kind)
    {
        optionId = null;
        kind = null;

        Dictionary<string, object> record = value as Dictionary<string, object>;
        if (record == null ||
            !HasExactKeys(
                record,
                new string[]
                {
                    "kind",
                    "optionId",
                    "label",
                    "container",
                    "width",
                    "height",
                    "fps",
                    "videoCodec",
                    "audioCodec",
                    "hasAudio",
                    "requiresMerge",
                    "filesizeBytes"
                },
                new string[] { "estimatedBytes", "sizeIsEstimate", "outputFormats", "outputSizes", "formatIds", "hdr" }))
        {
            return false;
        }

        string kindValue = record["kind"] as string;
        if (kindValue != "video" && kindValue != "audio")
        {
            return false;
        }
        if (!IsOpaqueMediaId(record["optionId"]) ||
            !IsSafeText(record["label"], 240))
        {
            return false;
        }

        string container = record["container"] as string;
        if (container == null || !ContainerPattern.IsMatch(container))
        {
            return false;
        }

        if (!ValidateNullableInteger(record["width"], 1, 65535) ||
            !ValidateNullableInteger(record["height"], 1, 65535) ||
            !ValidateNullableInteger(record["filesizeBytes"], 0, long.MaxValue))
        {
            return false;
        }
        if (record.ContainsKey("estimatedBytes") &&
            !ValidateNullableInteger(record["estimatedBytes"], 0, long.MaxValue))
        {
            return false;
        }
        if (record.ContainsKey("sizeIsEstimate") &&
            !(record["sizeIsEstimate"] is bool))
        {
            return false;
        }
        if (record.ContainsKey("hdr") && !(record["hdr"] is bool))
        {
            return false;
        }
        if (record.ContainsKey("outputFormats"))
        {
            object[] outputFormats = record["outputFormats"] as object[];
            if (outputFormats == null ||
                outputFormats.Length == 0 ||
                outputFormats.Length > 4)
            {
                return false;
            }
            System.Collections.Generic.HashSet<string> seen =
                new System.Collections.Generic.HashSet<string>();
            foreach (object outputFormatValue in outputFormats)
            {
                string format = outputFormatValue as string;
                if (format != "auto" &&
                    format != "mp4" &&
                    format != "mkv" &&
                    format != "webm")
                {
                    return false;
                }
                if (!seen.Add(format))
                {
                    return false;
                }
            }
        }
        if (record.ContainsKey("formatIds"))
        {
            object[] formatIds = record["formatIds"] as object[];
            if (formatIds == null || formatIds.Length < 1 || formatIds.Length > 2)
            {
                return false;
            }
            foreach (object formatIdValue in formatIds)
            {
                string formatId = formatIdValue as string;
                if (formatId == null ||
                    !System.Text.RegularExpressions.Regex.IsMatch(
                        formatId,
                        "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$"))
                {
                    return false;
                }
            }
        }
        if (record.ContainsKey("outputSizes"))
        {
            Dictionary<string, object> outputSizes =
                record["outputSizes"] as Dictionary<string, object>;
            if (outputSizes == null || outputSizes.Count > 4)
            {
                return false;
            }
            foreach (KeyValuePair<string, object> pair in outputSizes)
            {
                if (pair.Key != "auto" && pair.Key != "mp4" &&
                    pair.Key != "mkv" && pair.Key != "webm")
                {
                    return false;
                }
                Dictionary<string, object> size =
                    pair.Value as Dictionary<string, object>;
                if (size == null ||
                    !HasExactKeys(size,
                        new string[] { "bytes", "isEstimate" },
                        new string[0]) ||
                    !ValidateNullableInteger(size["bytes"], 0, long.MaxValue) ||
                    !(size["isEstimate"] is bool))
                {
                    return false;
                }
            }
        }

        if (record["fps"] != null)
        {
            double fps;
            if (!TryGetDouble(record["fps"], out fps) || fps < 0 || fps > 1000)
            {
                return false;
            }
        }

        if (!ValidateNullableText(record["videoCodec"], 64) ||
            !ValidateNullableText(record["audioCodec"], 64))
        {
            return false;
        }

        if (!(record["hasAudio"] is bool) || !(record["requiresMerge"] is bool))
        {
            return false;
        }

        optionId = (string)record["optionId"];
        kind = kindValue;
        return true;
    }

    private static bool ValidateMediaJob(object value)
    {
        Dictionary<string, object> record = value as Dictionary<string, object>;
        if (record == null ||
            !HasExactKeys(
                record,
                new string[]
                {
                    "id",
                    "analysisId",
                    "optionId",
                    "kind",
                    "title",
                    "label",
                    "status",
                    "completedBytes",
                    "totalBytes",
                    "speedBps",
                    "errorMessage",
                    "createdAt",
                    "updatedAt",
                    "completedAt"
                },
                new string[0]))
        {
            return false;
        }

        if (!IsOpaqueMediaId(record["id"]) ||
            !IsOpaqueMediaId(record["analysisId"]) ||
            !IsOpaqueMediaId(record["optionId"]))
        {
            return false;
        }

        string kind = record["kind"] as string;
        if (kind != "video" && kind != "audio")
        {
            return false;
        }
        if (!IsSafeText(record["title"], 500) ||
            !IsSafeText(record["label"], 240))
        {
            return false;
        }

        string status = record["status"] as string;
        if (status == null || Array.IndexOf(MediaJobStatuses, status) < 0)
        {
            return false;
        }

        long completedBytes;
        if (!TryGetLong(record["completedBytes"], out completedBytes) || completedBytes < 0)
        {
            return false;
        }
        if (!ValidateNullableInteger(record["totalBytes"], 0, long.MaxValue))
        {
            return false;
        }

        double speedBps;
        if (!TryGetDouble(record["speedBps"], out speedBps) || speedBps < 0)
        {
            return false;
        }

        if (!ValidateNullableText(record["errorMessage"], 2000))
        {
            return false;
        }

        long createdAt;
        long updatedAt;
        if (!TryGetLong(record["createdAt"], out createdAt) || createdAt < 1 ||
            !TryGetLong(record["updatedAt"], out updatedAt) || updatedAt < 1)
        {
            return false;
        }
        if (!ValidateNullableInteger(record["completedAt"], 1, long.MaxValue))
        {
            return false;
        }

        return true;
    }

    private static bool ReferencesMediaKind(
        object value,
        Dictionary<string, string> kinds,
        string expectedKind)
    {
        string id = value as string;
        if (id == null || !OpaqueMediaIdPattern.IsMatch(id))
        {
            return false;
        }
        string actualKind;
        return kinds.TryGetValue(id, out actualKind) && actualKind == expectedKind;
    }

    private static bool ValidateNullableInteger(object value, long minimum, long maximum)
    {
        if (value == null)
        {
            return true;
        }
        long number;
        return TryGetLong(value, out number) && number >= minimum && number <= maximum;
    }

    private static bool ValidateNullableText(object value, int maximum)
    {
        return value == null || IsSafeText(value, maximum);
    }

    private static bool IsSafeText(object value, int maximum)
    {
        string text = value as string;
        if (text == null || text.Trim().Length == 0 || text.Length > maximum)
        {
            return false;
        }
        for (int index = 0; index < text.Length; index++)
        {
            char character = text[index];
            if (character < 0x20 || character == 0x7f)
            {
                return false;
            }
        }
        return true;
    }

    private static bool TryGetLong(object value, out long result)
    {
        result = 0;
        if (value is int)
        {
            result = (int)value;
            return true;
        }
        if (value is long)
        {
            result = (long)value;
            return true;
        }
        if (value is decimal)
        {
            decimal number = (decimal)value;
            if (number == decimal.Truncate(number) &&
                number >= long.MinValue && number <= long.MaxValue)
            {
                result = (long)number;
                return true;
            }
            return false;
        }
        if (value is double)
        {
            double number = (double)value;
            if (!double.IsNaN(number) && !double.IsInfinity(number) &&
                number == Math.Truncate(number) &&
                number >= long.MinValue && number <= long.MaxValue)
            {
                result = (long)number;
                return true;
            }
        }
        return false;
    }

    private static bool TryGetDouble(object value, out double result)
    {
        result = 0;
        if (value is int)
        {
            result = (int)value;
            return true;
        }
        if (value is long)
        {
            result = (long)value;
            return true;
        }
        if (value is decimal)
        {
            result = (double)(decimal)value;
            return true;
        }
        if (value is double)
        {
            result = (double)value;
            return true;
        }
        return false;
    }

    private static bool TryLoadBridgeState(out BridgeState state, out string message)
    {
        state = null;
        message = "DonDownload is not running. Start DonDownload (the tray icon is enough), then try again.";

        // If more than one development/packaged userData folder has a state
        // file, prefer the newest endpoint instead of a stale one.
        BridgeState best = null;
        long bestStartedAt = long.MinValue;
        string lastError = null;

        string[] candidates = CandidateStatePaths();
        for (int index = 0; index < candidates.Length; index++)
        {
            string candidate = candidates[index];
            if (string.IsNullOrEmpty(candidate))
            {
                continue;
            }

            BridgeState parsedState;
            string parseError;
            if (TryReadBridgeState(candidate, out parsedState, out parseError))
            {
                if (best == null || parsedState.StartedAt > bestStartedAt)
                {
                    best = parsedState;
                    bestStartedAt = parsedState.StartedAt;
                }
            }
            else if (!string.IsNullOrEmpty(parseError))
            {
                lastError = parseError;
            }
        }

        if (best != null)
        {
            state = best;
            return true;
        }
        if (!string.IsNullOrEmpty(lastError))
        {
            message = lastError;
        }
        return false;
    }

    private static string[] CandidateStatePaths()
    {
        List<string> paths = new List<string>();

        string overridePath = Environment.GetEnvironmentVariable("DONDOWNLOAD_BRIDGE_STATE");
        if (!string.IsNullOrEmpty(overridePath))
        {
            paths.Add(overridePath);
        }

        string appData = Environment.GetEnvironmentVariable("APPDATA");
        if (string.IsNullOrEmpty(appData))
        {
            // Fall back to the shell-known roaming folder when the environment
            // value is unavailable (for example in a stripped-down launcher).
            appData = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
        }

        if (!string.IsNullOrEmpty(appData))
        {
            // Electron's app name in this project is "dondownload"; keep the
            // display-name variant for future packaging changes.
            paths.Add(Path.Combine(appData, "dondownload", StateFileName));
            paths.Add(Path.Combine(appData, "DonDownload", StateFileName));
        }

        return paths.ToArray();
    }

    private static bool TryReadBridgeState(
        string filePath,
        out BridgeState state,
        out string errorMessage)
    {
        state = null;
        errorMessage = null;

        string text;
        try
        {
            if (!File.Exists(filePath))
            {
                return false;
            }

            FileInfo info = new FileInfo(filePath);
            if (info.Length <= 0 || info.Length > MaxStateBytes)
            {
                errorMessage =
                    "DonDownload's browser bridge state is invalid. Restart DonDownload, then try again.";
                return false;
            }

            using (FileStream stream = new FileStream(filePath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
            using (StreamReader reader = new StreamReader(stream, new UTF8Encoding(false, true), true))
            {
                text = reader.ReadToEnd();
            }
        }
        catch (Exception)
        {
            errorMessage =
                "DonDownload's browser bridge state could not be read. Restart DonDownload, then try again.";
            return false;
        }

        if (text.Length > MaxStateBytes)
        {
            errorMessage =
                "DonDownload's browser bridge state is invalid. Restart DonDownload, then try again.";
            return false;
        }

        object parsed;
        try
        {
            parsed = Serializer.DeserializeObject(text);
        }
        catch (Exception)
        {
            errorMessage =
                "DonDownload's browser bridge state is invalid. Restart DonDownload, then try again.";
            return false;
        }

        Dictionary<string, object> record = parsed as Dictionary<string, object>;
        if (record == null)
        {
            errorMessage =
                "DonDownload's browser bridge state is invalid. Restart DonDownload, then try again.";
            return false;
        }

        object appValue = record.ContainsKey("app") ? record["app"] : null;
        object versionValue = record.ContainsKey("version") ? record["version"] : null;
        object portValue = record.ContainsKey("port") ? record["port"] : null;
        object tokenValue = record.ContainsKey("token") ? record["token"] : null;
        object startedValue = record.ContainsKey("startedAt") ? record["startedAt"] : null;

        if (!(appValue is string) || (string)appValue != AppMarker)
        {
            return false;
        }
        if (!(versionValue is int) || (int)versionValue != StateVersion)
        {
            errorMessage =
                "DonDownload's browser bridge state has an unsupported version. Restart DonDownload.";
            return false;
        }

        int port;
        if (portValue is int)
        {
            port = (int)portValue;
        }
        else if (portValue is long)
        {
            port = (int)(long)portValue;
        }
        else
        {
            errorMessage =
                "DonDownload's browser bridge state is invalid. Restart DonDownload, then try again.";
            return false;
        }

        if (port < 1 || port > 65535)
        {
            errorMessage =
                "DonDownload's browser bridge state is invalid. Restart DonDownload, then try again.";
            return false;
        }

        string token = tokenValue as string;
        if (token == null || !TokenPattern.IsMatch(token))
        {
            errorMessage =
                "DonDownload's browser bridge state is invalid. Restart DonDownload, then try again.";
            return false;
        }

        long startedAt;
        if (startedValue is int)
        {
            startedAt = (int)startedValue;
        }
        else if (startedValue is long)
        {
            startedAt = (long)startedValue;
        }
        else
        {
            errorMessage =
                "DonDownload's browser bridge state is invalid. Restart DonDownload, then try again.";
            return false;
        }

        if (startedAt <= 0)
        {
            errorMessage =
                "DonDownload's browser bridge state is invalid. Restart DonDownload, then try again.";
            return false;
        }

        BridgeState loaded = new BridgeState();
        loaded.Port = port;
        loaded.Token = token;
        loaded.StartedAt = startedAt;
        state = loaded;
        return true;
    }

    private static bool TryNormalizeUrl(string value, out string normalized, out string message)
    {
        normalized = null;
        message = null;

        if (value == null)
        {
            message = "Enter a download URL.";
            return false;
        }

        string raw = value.Trim();
        if (raw.Length == 0)
        {
            message = "Enter a download URL.";
            return false;
        }
        if (raw.Length > MaxUrlLength)
        {
            message = "The URL is too long (maximum 4096 characters).";
            return false;
        }

        for (int index = 0; index < raw.Length; index++)
        {
            char character = raw[index];
            if (character < 0x20 || character == 0x7f)
            {
                message = "The URL contains unsupported control characters.";
                return false;
            }
        }

        Uri uri;
        if (!Uri.TryCreate(raw, UriKind.Absolute, out uri))
        {
            message = "That does not look like a valid URL.";
            return false;
        }
        if (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps)
        {
            message = "Only http:// and https:// URLs are supported.";
            return false;
        }
        if (string.IsNullOrEmpty(uri.Host))
        {
            message = "The URL must include a host name.";
            return false;
        }
        if (!string.IsNullOrEmpty(uri.UserInfo))
        {
            message = "URLs containing embedded credentials are not supported.";
            return false;
        }

        try
        {
            UriBuilder builder = new UriBuilder(uri);
            builder.Fragment = string.Empty;
            normalized = builder.Uri.AbsoluteUri;
        }
        catch (Exception)
        {
            message = "That does not look like a valid URL.";
            return false;
        }

        if (normalized.Length > MaxUrlLength)
        {
            message = "The URL is too long (maximum 4096 characters).";
            return false;
        }

        return true;
    }

    private static Dictionary<string, object> Error(string code, string message)
    {
        Dictionary<string, object> error = new Dictionary<string, object>();
        error.Add("code", code);
        error.Add("message", message);

        Dictionary<string, object> response = new Dictionary<string, object>();
        response.Add("ok", false);
        response.Add("error", error);
        return response;
    }

    private static void WriteResponse(Stream output, Dictionary<string, object> response)
    {
        byte[] payload = Encoding.UTF8.GetBytes(Serializer.Serialize(response));
        if (payload.Length > MaxFrameBytes)
        {
            return;
        }

        byte[] header = new byte[4];
        header[0] = (byte)(payload.Length & 0xff);
        header[1] = (byte)((payload.Length >> 8) & 0xff);
        header[2] = (byte)((payload.Length >> 16) & 0xff);
        header[3] = (byte)((payload.Length >> 24) & 0xff);

        output.Write(header, 0, header.Length);
        output.Write(payload, 0, payload.Length);
        output.Flush();
    }

    private static FrameStatus ReadFrameLength(Stream input, out int length)
    {
        length = 0;
        byte[] header = new byte[4];
        int read = ReadAtMost(input, header, 0, header.Length);

        if (read == 0)
        {
            return FrameStatus.EndOfStream;
        }
        if (read != header.Length)
        {
            return FrameStatus.Invalid;
        }

        length = header[0] | (header[1] << 8) | (header[2] << 16) | (header[3] << 24);
        if (length <= 0)
        {
            return FrameStatus.Invalid;
        }
        if (length > MaxFrameBytes)
        {
            return FrameStatus.TooLarge;
        }

        return FrameStatus.Ok;
    }

    private static int ReadAtMost(Stream input, byte[] buffer, int offset, int count)
    {
        int total = 0;
        while (total < count)
        {
            int read = input.Read(buffer, offset + total, count - total);
            if (read <= 0)
            {
                break;
            }
            total += read;
        }
        return total;
    }

    private static bool ReadExactly(Stream input, byte[] buffer, int offset, int count)
    {
        int total = 0;
        while (total < count)
        {
            int read = input.Read(buffer, offset + total, count - total);
            if (read <= 0)
            {
                return false;
            }
            total += read;
        }
        return true;
    }

    private static string ReadBounded(Stream stream, int maximum)
    {
        if (stream == null)
        {
            throw new InvalidDataException("Missing response stream.");
        }

        using (MemoryStream memory = new MemoryStream())
        {
            byte[] buffer = new byte[4096];
            int total = 0;
            while (true)
            {
                int read = stream.Read(buffer, 0, buffer.Length);
                if (read <= 0)
                {
                    break;
                }
                total += read;
                if (total > maximum)
                {
                    throw new InvalidDataException("Response is too large.");
                }
                memory.Write(buffer, 0, read);
            }

            return new UTF8Encoding(false, true).GetString(memory.ToArray());
        }
    }
}
