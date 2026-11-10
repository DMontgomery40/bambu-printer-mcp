export function screwCheck(s, L, m) {
    // shear strength of the plate around the head: across the layers when the axis lies in them (the shear
    // cylinder then cuts layer planes at its top and bottom), within the layers otherwise
    const tauZ = m.Stz ?? m.Sz / Math.sqrt(3), tauXY = m.Sxy / Math.sqrt(3);
    const tau = s.axisInLayers ? tauZ : tauXY;
    const k = s.countersunk ? (s.head - s.d) / 2 : 0;
    const dEff = s.countersunk ? (s.head + s.d) / 2 : s.head;
    const pull = tau * Math.PI * dEff * s.plate;
    const sfPull = pull / Math.max(L.tension, 1e-9);
    let hoop, sfHoop, why = "";
    if (s.countersunk && k > 0) {
        // 90-degree cone: outward push = pull; the ring around it (width = margin, height = k) carries hoop tension F/(2 pi) / (w k)
        const sigma = L.tension / (2 * Math.PI) / Math.max(1e-6, s.margin * k);
        const S = s.axisInLayers ? Math.min(m.Sxy, m.Sz) : m.Sxy;
        hoop = sigma;
        sfHoop = S / Math.max(sigma, 1e-12);
        why = `; countersink wedge: hoop stress ${sigma.toFixed(2)} MPa in the ${s.margin.toFixed(1)} mm ring around the ${k.toFixed(2)} mm deep cone (strength ${S} MPa), SF ${sfHoop.toFixed(1)}`;
    }
    const mode = sfHoop !== undefined && sfHoop < sfPull ? "countersink ring splits" : "head pulls through";
    return { name: s.name, pullThrough: pull, sfPull, hoop, sfHoop, mode,
        why: `tension ${L.tension.toFixed(1)} N, sideways ${L.lateral.toFixed(1)} N (from the whole-part solve, no preload); pull-through: shear ${tau.toFixed(1)} MPa (${s.axisInLayers ? `across the layers: S_z/sqrt(3) assumed, no measured value` : "within the layers: S_xy/sqrt(3)"}) on a ${dEff.toFixed(1)} mm cylinder ${s.plate.toFixed(1)} mm long = ${pull.toFixed(0)} N, SF ${sfPull.toFixed(1)}${why}` };
}
