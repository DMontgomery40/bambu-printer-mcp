import { COUNTERPART_CONTRACT } from "./schemas.js";
/** optional: an optional dependency, whose failure does not make ok false (mcp-3D-printer-server has one; this server none). */
export type SelfCheck = {
    name: string;
    ok: boolean;
    optional?: boolean;
    version?: string;
    message?: string;
};
export type SelfCheckResult = {
    contract: typeof COUNTERPART_CONTRACT;
    server: {
        name: string;
        version: string;
    };
    ok: boolean;
    checks: SelfCheck[];
};
export declare const SELF_CHECK_OUTPUT_SCHEMA: {
    type: "object";
    properties: {
        contract: {
            type: string;
            const: string;
        };
        server: {
            type: string;
            properties: {
                name: {
                    type: string;
                };
                version: {
                    type: string;
                };
            };
            required: string[];
        };
        ok: {
            type: string;
            description: string;
        };
        checks: {
            type: string;
            items: {
                type: string;
                properties: {
                    name: {
                        type: string;
                    };
                    ok: {
                        type: string;
                    };
                    optional: {
                        type: string;
                    };
                    version: {
                        type: string;
                    };
                    message: {
                        type: string;
                    };
                };
                required: string[];
            };
        };
    };
    required: string[];
};
/**
 * Whether version meets declared, for the forms package.json uses: x.y.z exactly, ^x.y.z (the leftmost non-zero
 * part stays) or ~x.y.z (the minor stays). Other forms are not judged (undefined).
 */
export declare function meetsDeclared(version: string, declared: string): boolean | undefined;
export declare function selfCheck(server: {
    name: string;
    version: string;
}): Promise<SelfCheckResult>;
