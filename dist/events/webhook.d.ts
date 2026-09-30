import type { ClientRequest, IncomingMessage, RequestOptions } from "node:http";
export interface CallbackResponse {
    status: number;
    body: string;
}
export type CallbackSender = (url: string, body: string, headers: Record<string, string>) => Promise<CallbackResponse>;
export declare function signingKey(secret: string): Buffer;
export declare function sign(secret: string, id: string, seconds: number, body: string): string;
export declare function sameChallenge(actual: unknown, expected: string): boolean;
export declare function callbackUrl(value: unknown): URL;
/** Conservative public-unicast policy; reject mapped IPv6 and special-use ranges. */
export declare function publicAddress(address: string): boolean;
/** Resolve at every connection and pin a validated address; no redirect following or proxy. */
export declare function createPublicCallbackSender(resolver?: (hostname: string) => Promise<{
    address: string;
    family: number;
}[]>, httpsRequest?: (url: URL, options: RequestOptions, callback: (res: IncomingMessage) => void) => ClientRequest): CallbackSender;
export declare const sendPublicCallback: CallbackSender;
