/** Independent hardware ceilings. Editable slicer profiles never raise these limits.
 * Manufacturer references (verified 2026-09-27):
 * P1P: https://public-cdn.bambulab.com/store/bambulab-P1P-tech-specs.pdf
 * P1S: https://cdn1.bambulab.com/documentation/quick-start-59b0cefdc0fc4/P1S/English%20version-Quick%20Start%20Guide%20for%20P1S.pdf
 * A1: https://bambulab.com/en/a1/tech-specs
 * A1 mini: https://us.store.bambulab.com/products/a1-mini
 * X1/X1C: https://cdn1.bambulab.com/documentation/Quick%20Start%20Guide%20for%20X1%20Combo%26X1-Carbon%20Combo-v1.pdf
 * X1E: https://cdn1.bambulab.com/x1e/spec/Bambu%20Lab%20X1E%20Technical%20Specification.pdf
 * H2D: https://cdn1.bambulab.com/documentation/h2d/en/H2D_Laser_Full_Combo_20250305.pdf
 * H2D Pro: https://bambulab.com/en/h2d-pro/tech-specs
 * H2C: https://csm.bblcdn.com/hub/eca403f48aee405393afc97adbbf6422.pdf
 * H2S: https://bambulab.com/it/support/buying-guide
 * P2S: https://blog.bambulab.com/the-icon-redefined-meet-the-p2s-a-completely-reengineered-version-of-the-ultra-productive-p1-series/
 * X2D: https://csm.bblcdn.com/hub/7c58718aaa2e40edab56efb87419a96a.pdf
 * X1-family bed caps use 110 C: 120 C requires verified 110 V supply, unavailable here.
 * A zero chamber cap means no supported active chamber heater, not ambient temperature.
 */
export declare const MACHINE_LIMITS: Readonly<Record<string, {
    nozzle: number;
    bed: number;
    chamber: number;
    volume: readonly number[];
}>>;
export declare function normalizeModel(value: unknown): string | undefined;
export declare function normalizeMaterial(value: unknown): string | undefined;
export declare function validateTemperature(component: 'nozzle' | 'bed' | 'chamber', value: unknown, model: string, materials?: string[]): number;
