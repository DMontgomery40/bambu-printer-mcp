/** counterpart/1: the `_meta` key and value that mark a print_3mf progress notification as the file upload. */
export declare const UPLOAD_STAGE_META: {
    readonly "counterpart/stage": "upload";
};
export interface UploadProgressParams {
    progress: number;
    total: number;
    message: string;
    _meta: typeof UPLOAD_STAGE_META;
}
/**
 * Turns bytes sent over FTPS into MCP progress params: progress = bytes sent, total = file bytes,
 * marked as the upload stage, at most once per whole percent so a slow upload doesn't flood the client.
 */
export declare function uploadProgressReporter(send: (params: UploadProgressParams) => void): (sent: number, total: number) => void;
