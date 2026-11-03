export type PrintRoute = "lan" | "cloud";
export declare const PRINT_ROUTES: readonly PrintRoute[];
export interface Connection {
    mode: string;
    type: string;
}
/** Bambu Cloud is FULU's BambuNetwork with connection type cloud; every other route is the local network. */
export declare function routeOf(connection: Connection): PrintRoute;
/**
 * The configured defaults for a route. Cloud needs FULU's BambuNetwork. The local network keeps the
 * configured mode (direct LAN, X2D native, Bambu Connect or BambuNetwork) and, for BambuNetwork, uses its LAN type.
 */
export declare function connectionForRoute(route: PrintRoute, current: Connection): Connection;
/** Set KEY=value lines in a dotenv file, keeping every other line and the file's permissions. */
export declare function writeEnvValues(file: string, values: Record<string, string>): void;
