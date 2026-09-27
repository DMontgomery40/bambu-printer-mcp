<script setup lang="ts">
import { withBase } from 'vitepress'
</script>

<template>
  <section class="home-section print-path" aria-labelledby="print-path-heading">
    <div class="home-wrap">
      <h2 id="print-path-heading" class="home-h2">From slicer to printer</h2>
      <p class="home-lede">
        The recommended path starts from a file you've sliced and previewed yourself. The server handles the
        model-specific upload and print command.
      </p>
      <ol class="print-path__steps">
        <li>
          <h3>Slice and export</h3>
          <p>
            Slice in FULU OrcaSlicer-bambulab, OrcaSlicer, or Bambu Studio. Export the sliced plate as a
            <code>.gcode.3mf</code>.
          </p>
        </li>
        <li>
          <h3>Hand it to <code>print_3mf</code></h3>
          <p>It checks the file for plate G-code and builds the AMS mapping from the slicer metadata and any trays you choose.</p>
        </li>
        <li>
          <h3>Upload over FTPS</h3>
          <p>The file goes to the printer on port 990, to the location that model expects.</p>
        </li>
        <li>
          <h3>Start over MQTT</h3>
          <p>
            The model's print command goes out on port 8883. A sent command isn't a finished print, so check
            status and HMS errors afterward.
          </p>
        </li>
      </ol>
      <p class="print-path__more">
        <a class="home-link" :href="withBase('/guide/slicing')">Read the slicing guide</a>
        <a class="home-link" :href="withBase('/guide/slicing#firmware-routing-handled-internally')">See routing by model</a>
        <a class="home-link" :href="withBase('/guide/ams')">Map AMS trays</a>
      </p>
    </div>
  </section>
</template>

<style scoped>
.print-path__steps {
  list-style: none;
  counter-reset: step;
  margin: 48px 0 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  position: relative;
}

/* The rail: a strand of filament running through the steps. */
.print-path__steps::before {
  content: '';
  position: absolute;
  top: 17px;
  left: 18px;
  right: 18px;
  height: 3px;
  border-radius: 2px;
  background: linear-gradient(90deg, var(--tp-outer), var(--tp-inner) 45%, var(--vp-c-brand-1));
  opacity: 0.85;
}

.print-path__steps li {
  counter-increment: step;
  position: relative;
  padding: 56px 28px 0 0;
}

.print-path__steps li::before {
  content: counter(step);
  position: absolute;
  top: 0;
  left: 0;
  width: 37px;
  height: 37px;
  display: grid;
  place-items: center;
  border-radius: 50%;
  background: var(--vp-c-bg);
  border: 2px solid var(--vp-c-text-1);
  color: var(--vp-c-text-1);
  font-weight: 750;
  font-size: 15px;
  font-variant-numeric: tabular-nums;
}

.print-path__steps h3 {
  margin: 0 0 8px;
  font-size: 1.1875rem;
  line-height: 1.3;
  font-stretch: 110%;
  font-weight: 720;
}

.print-path__steps p {
  margin: 0;
  color: var(--vp-c-text-2);
  line-height: 1.6;
}

.print-path__steps code {
  font-family: var(--vp-font-family-mono);
  font-size: 0.88em;
}

.print-path__more {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 28px;
  margin: 44px 0 0;
}

@media (max-width: 960px) {
  .print-path__steps {
    grid-template-columns: minmax(0, 1fr);
    gap: 28px;
  }

  .print-path__steps::before {
    top: 18px;
    bottom: 18px;
    left: 17px;
    right: auto;
    width: 3px;
    height: auto;
    background: linear-gradient(180deg, var(--tp-outer), var(--tp-inner) 45%, var(--vp-c-brand-1));
  }

  .print-path__steps li {
    padding: 4px 0 0 60px;
  }
}
</style>
