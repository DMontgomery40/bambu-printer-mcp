<script setup lang="ts">
import { withBase } from 'vitepress'
import data from '../../generated/home.json'

const models = data.models
const notes = models.filter((model) => model.note)
</script>

<template>
  <section class="home-section home-printers" aria-labelledby="printers-heading">
    <div class="home-wrap home-printers__grid">
      <div>
        <h2 id="printers-heading" class="home-h2">Set for your exact printer</h2>
        <p class="home-lede">
          Upload paths, print commands, and slicer presets differ by model, so the server needs to know which
          one you have.
        </p>
        <ul class="home-printers__plates" aria-label="Supported printer models">
          <li v-for="model in models" :key="model.code" :class="{ limited: model.note }">
            {{ model.label }}<span v-if="model.note" class="home-printers__mark" aria-hidden="true">*</span>
          </li>
        </ul>
        <p v-for="model in notes" :key="model.code" class="home-printers__note">
          <span aria-hidden="true">*</span> {{ model.label }}: {{ model.note }}
        </p>
      </div>
      <div class="home-printers__guard">
        <h3>It stops instead of guessing</h3>
        <ul>
          <li>
            Set <code>BAMBU_MODEL</code> or pass <code>bambu_model</code>. Without it, print tools ask or stop with
            an error, because G-code for the wrong model can damage hardware.
          </li>
          <li>A failed inspection or slice stops before upload. The unsliced project is never sent as a fallback.</li>
          <li>Deleting a file on the printer requires <code>confirm: true</code>.</li>
          <li>
            A successful response means the command was sent. Check status, HMS errors, and the printer itself.
          </li>
        </ul>
        <a class="home-link" :href="withBase('/reference/limitations')">Read the limitations</a>
      </div>
    </div>
  </section>
</template>

<style scoped>
.home-printers__grid {
  display: grid;
  grid-template-columns: minmax(0, 7fr) minmax(0, 5fr);
  gap: 64px;
  align-items: start;
}

.home-printers__plates {
  list-style: none;
  margin: 36px 0 0;
  padding: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}

/* Styled after the model badge on a printer's front panel. */
.home-printers__plates li {
  min-width: 84px;
  padding: 12px 16px;
  border-radius: 8px;
  border: 1.5px solid var(--vp-c-text-1);
  font-size: 1.125rem;
  font-stretch: 122%;
  font-weight: 760;
  letter-spacing: 0.01em;
  text-align: center;
  color: var(--vp-c-text-1);
  background: var(--bp-raised);
}

.home-printers__plates li.limited {
  border-style: dashed;
  color: var(--vp-c-text-2);
  background: transparent;
}

.home-printers__mark {
  margin-left: 2px;
  color: var(--tp-outer);
}

.home-printers__note {
  margin: 16px 0 0;
  font-size: 0.9375rem;
  color: var(--vp-c-text-2);
}

.home-printers__note span {
  color: var(--tp-outer);
  font-weight: 700;
}

.home-printers__guard {
  padding: 28px;
  border-radius: 14px;
  background: var(--bp-panel);
  border: 1px solid var(--bp-line);
}

.home-printers__guard h3 {
  margin: 0 0 16px;
  font-size: 1.1875rem;
  font-stretch: 112%;
  font-weight: 740;
}

.home-printers__guard ul {
  margin: 0 0 20px;
  padding: 0 0 0 18px;
  list-style: disc outside;
  display: grid;
  gap: 12px;
  color: var(--vp-c-text-2);
  line-height: 1.55;
}

.home-printers__guard li::marker {
  color: var(--vp-c-brand-1);
}

.home-printers__guard code {
  font-family: var(--vp-font-family-mono);
  font-size: 0.86em;
  padding: 1px 5px;
  border-radius: 4px;
  background: var(--vp-code-bg);
  color: var(--vp-c-text-1);
  white-space: nowrap;
}

@media (max-width: 960px) {
  .home-printers__grid {
    grid-template-columns: minmax(0, 1fr);
    gap: 40px;
  }
}

@media (max-width: 640px) {
  .home-printers__plates li {
    min-width: 72px;
    padding: 10px 12px;
    font-size: 1rem;
  }

  .home-printers__guard {
    padding: 22px 18px;
  }
}
</style>
