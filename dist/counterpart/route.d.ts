/**
 * lan: the local network through FULU's BambuNetwork bridge (or the configured X2D native or Bambu Connect mode).
 * cloud: Bambu Cloud through FULU's bridge.
 * developer: the local network straight to the printer (lan_mqtt_ftps), for a printer in LAN Only + Developer Mode.
 */
export type PrintRoute = "lan" | "cloud" | "developer";
export declare const PRINT_ROUTES: readonly PrintRoute[];
export interface Connection {
    mode: string;
    type: string;
}
/** One connection a person can choose, as counterpart_print_route reports it. */
export interface RouteOption {
    id: PrintRoute;
    label: string;
    available: boolean;
    /** Why it can't be chosen here, when it can't. */
    reason?: string;
    /** What Pause, Resume and Stop do on this connection. */
    controls: string;
}
export declare function routeOf(connection: Connection): PrintRoute;
/** The current connection when it is its own local route (X2D native or Bambu Connect); otherwise none. */
export declare function ownLocalOf(current: Connection): Connection | undefined;
/**
 * Every connection, and whether this server can use it (bridgeConfigured: BAMBU_NETWORK_BRIDGE_COMMAND is set).
 * ownLocal is the printer's own local route (X2D native or Bambu Connect), kept apart from the current choice
 * so switching to Developer Mode or Bambu Cloud and back returns to it.
 */
export declare function routeOptions(current: Connection, bridgeConfigured: boolean, ownLocal?: Connection | undefined): RouteOption[];
/**
 * The configured defaults for a route. Cloud and the local network use FULU's BambuNetwork; an X2D native or
 * Bambu Connect setup keeps its own mode for the local network. Developer Mode is the direct LAN route.
 */
export declare function connectionForRoute(route: PrintRoute, current: Connection, bridgeConfigured?: boolean, ownLocal?: Connection | undefined): Connection;
/** Set KEY=value lines in a dotenv file, keeping every other line and the file's permissions. */
export declare function writeEnvValues(file: string, values: Record<string, string>): void;
