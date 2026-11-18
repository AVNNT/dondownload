/**
 * Windows application identity shared by the installer and toast activation.
 *
 * The NSIS installer creates its Start Menu shortcut with this AppUserModelID,
 * and Windows routes toast button activations back to the process that set the
 * same id with `app.setAppUserModelId`. They must never drift apart, which is
 * why both the main process and the packaging test read this one constant.
 */
export const APP_USER_MODEL_ID = 'com.dondownload.app'
