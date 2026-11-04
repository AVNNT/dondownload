using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Net;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;

// DonDownload native messaging host.
//
// Protocol: Chrome/Edge standard native messaging framing on stdin/stdout:
//   4-byte little-endian length, then UTF-8 JSON. One request per frame.
//
// The only supported request is:
//   { "type": "queue-download", "url": "https://example.com/file.zip" }
//
// The host validates that schema and URL, discovers the per-user desktop
// bridge endpoint, and POSTs only the URL to loopback with a bearer token.
// It never accepts commands, paths, file names, or filesystem input. All
// diagnostics go to stderr and never include URLs.
internal static class NativeHost
{
    private const int MaxFrameBytes = 1024 * 1024;
    private const int MaxStateBytes = 8 * 1024;
    private const int MaxResponseBytes = 64 * 1024;
    private const int MaxUrlLength = 4096;
    private const string AppMarker = "DonDownload";
    private const int StateVersion = 1;
    private const string Operation = "queue-download";
    private const string StateFileName = "native-bridge.json";

    private static readonly Regex TokenPattern =
        new Regex("^[0-9a-f]{64}$", RegexOptions.CultureInvariant);
    private static readonly Regex ExtensionOriginPattern =
        new Regex("^chrome-extension://[a-p]{32}/?$", RegexOptions.CultureInvariant);

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
            // Chrome and Edge pass the caller origin as the first argument.
            // The browser manifest's allowed_origins is the authoritative
            // origin check; this rejects obviously non-extension launches too.
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
        bool hasForce = message != null && message.ContainsKey("force");
        int expectedCount = hasForce ? 3 : 2;
        if (message == null || message.Count != expectedCount ||
            !message.ContainsKey("type") || !message.ContainsKey("url"))
        {
            return Error(
                "INVALID_MESSAGE",
                "Only queue-download messages containing type, url and an optional force flag are accepted.");
        }

        string type = message["type"] as string;
        if (type == null || type != Operation)
        {
            return Error("UNSUPPORTED_OPERATION", "Only the queue-download operation is supported.");
        }

        bool force = false;
        if (hasForce)
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
            request = (HttpWebRequest)WebRequest.Create(
                "http://127.0.0.1:" + state.Port.ToString(CultureInfo.InvariantCulture) + "/queue-download");
            request.Method = "POST";
            request.ContentType = "application/json; charset=utf-8";
            request.Accept = "application/json";
            request.Headers[HttpRequestHeader.Authorization] = "Bearer " + state.Token;
            request.AllowAutoRedirect = false;
            request.Proxy = null;
            request.KeepAlive = false;
            // aria2 may need up to ~12 seconds to start on the first add. The
            // host still fails promptly when the loopback port is closed.
            request.Timeout = 20000;
            request.ReadWriteTimeout = 20000;
            request.ServicePoint.Expect100Continue = false;
            request.UserAgent = "DonDownload-Native/0.1.0";

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
