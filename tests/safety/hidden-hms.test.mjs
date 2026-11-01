import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HIDDEN_HMS, HIDDEN_HMS_SOURCE } from '../../dist/safety/hidden-hms.js';
import { SERIAL_MODELS } from '../../dist/safety/printer-state.js';
import { PREFIXES, STUDIO_COMMIT, STUDIO_TAG, assertCheckoutAtTag, hiddenCodes, render, tableVersion } from '../../scripts/generate-hidden-hms.mjs';

test('hidden HMS table covers the supported model tables from the pinned Bambu Studio release', () => {
  assert.equal(HIDDEN_HMS_SOURCE.studioTag, STUDIO_TAG);
  assert.equal(HIDDEN_HMS_SOURCE.studioCommit, STUDIO_COMMIT);
  assert.match(STUDIO_COMMIT, /^[0-9a-f]{40}$/);
  assert.deepEqual(Object.keys(HIDDEN_HMS).sort(), [...PREFIXES].sort());
  assert.deepEqual(Object.keys(HIDDEN_HMS_SOURCE.tables).sort(), [...PREFIXES].sort());
  for (const prefix of PREFIXES) assert.ok(SERIAL_MODELS[prefix], `${prefix} maps to a supported model, or its table would never apply`);
  for (const source of Object.values(HIDDEN_HMS_SOURCE.tables)) {
    assert.ok(Number.isInteger(source.version) && source.version > 0);
    assert.match(source.sha256, /^[0-9a-f]{64}$/);
  }
  for (const [prefix, codes] of Object.entries(HIDDEN_HMS)) {
    assert.ok(codes.length > 0, prefix);
    assert.ok(codes.every(code => /^[0-9A-F]{16}$/.test(code)), prefix);
    assert.deepEqual([...codes], [...new Set(codes)].sort(), `${prefix} is sorted and unique`);
  }
});

test('hidden HMS table matches Bambu-reported hidden camera codes per model', () => {
  // X2D re-raises 0500-0600-0002-0070 at every boot; Bambuddy #1840 saw 0005/0006 on an H2C.
  assert.ok(HIDDEN_HMS['20P'].includes('0500060000020070'));
  assert.ok(HIDDEN_HMS['31B'].includes('0500060000020005'));
  assert.ok(HIDDEN_HMS['31B'].includes('0500060000020006'));
  // Bambu's P2S table does not list the code at all, so it stays unknown there.
  assert.ok(!HIDDEN_HMS['22E'].includes('0500060000020070'));
  // Documented camera faults have text and are never hidden.
  assert.ok(!HIDDEN_HMS['20P'].includes('0500060000020002'));
});

test('generator keeps only codes blank in every entry and rejects malformed tables', () => {
  const table = { data: { device_hms: { ver: 202511162200, en: [
    { ecode: '0500060000020070', intro: '' },
    { ecode: '0500060000020071', intro: '  ' },
    { ecode: '0500060000020002', intro: 'The Nozzle Camera is not in place.' },
    { ecode: '0500060000020070', intro: '' },
    // Blank in one entry but documented in another: documented wins.
    { ecode: '0500060000020099', intro: '' },
    { ecode: '0500060000020099', intro: 'A documented fault.' },
  ] } } };
  assert.deepEqual(hiddenCodes(table), ['0500060000020070', '0500060000020071']);
  assert.equal(tableVersion('20P', table), 202511162200);
  assert.throws(() => tableVersion('20P', { data: { device_hms: { en: [] } } }), /no device_hms version/);
  assert.throws(() => assertCheckoutAtTag('/nonexistent-checkout', { run: () => { throw Object.assign(new Error('fail'), { stderr: 'fatal: not a git repository' }); } }), /not a Bambu Studio checkout/);
  assert.throws(() => assertCheckoutAtTag('/some/checkout', { run: () => 'v02.08.04.57\n' }), /is at v02\.08\.04\.57, not the pinned/);
  const at = head => (_command, args) => args.includes('describe') ? `${STUDIO_TAG}\n` : `${head}\n`;
  assert.throws(() => assertCheckoutAtTag('/some/checkout', { run: at('f'.repeat(40)) }), /not the pinned commit/);
  assert.doesNotThrow(() => assertCheckoutAtTag('/some/checkout', { run: at(STUDIO_COMMIT) }));
  const rendered = render({ codes: Object.fromEntries(PREFIXES.map(p => [p, ['0500060000020070']])), digests: Object.fromEntries(PREFIXES.map(p => [p, 'a'.repeat(64)])), versions: Object.fromEntries(PREFIXES.map(p => [p, 1])) });
  assert.match(rendered, /studioCommit: "[0-9a-f]{40}"/);
  assert.match(rendered, /"20P": \{ version: 1, sha256: "a{64}" \}/);
  assert.throws(() => hiddenCodes({ data: { device_hms: { en: [{ ecode: 'XYZ', intro: '' }] } } }), /Malformed/);
  assert.throws(() => hiddenCodes({ data: { device_hms: { en: [{ ecode: '0500060000020070' }] } } }), /no intro/);
  assert.throws(() => hiddenCodes({ data: {} }), /no English device_hms/);
});

test('HMS messages and stage words come from the same pinned tables and commit as the hidden list', async () => {
  const { HMS_MESSAGES, HMS_MESSAGES_SOURCE, PRINT_ERROR_MESSAGES } = await import('../../dist/safety/hms-messages.js');
  const { BAMBU_STAGES, BAMBU_STAGES_SOURCE } = await import('../../dist/printers/bambu-stages.js');
  assert.equal(HMS_MESSAGES_SOURCE.studioCommit, HIDDEN_HMS_SOURCE.studioCommit);
  assert.equal(BAMBU_STAGES_SOURCE.studioCommit, HIDDEN_HMS_SOURCE.studioCommit);
  assert.equal(HMS_MESSAGES_SOURCE.studioTag, STUDIO_TAG);
  for (const prefix of PREFIXES) {
    assert.equal(HMS_MESSAGES_SOURCE.tables[prefix].sha256, HIDDEN_HMS_SOURCE.tables[prefix].sha256, `${prefix} read the same file`);
    assert.equal(HMS_MESSAGES_SOURCE.tables[prefix].hmsVersion, HIDDEN_HMS_SOURCE.tables[prefix].version);
  }
  assert.match(BAMBU_STAGES_SOURCE.sha256, /^[0-9a-f]{64}$/);
  assert.ok(Object.keys(HMS_MESSAGES).every(code => /^[0-9A-F]{16}$/.test(code)));
  assert.ok(Object.keys(PRINT_ERROR_MESSAGES).every(code => /^[0-9A-F]{8}$/.test(code)));
  assert.ok(Object.values(HMS_MESSAGES).every(text => typeof text === 'string' ? text.trim() : text['*']?.trim()), 'only documented text is kept');
  // A hidden code is blank in its own table, so that table never supplies text for it.
  for (const [prefix, codes] of Object.entries(HIDDEN_HMS)) {
    for (const code of codes) {
      const text = HMS_MESSAGES[code];
      assert.ok(text === undefined || typeof text === 'string' || !(prefix in text), `${prefix} ${code}`);
    }
  }
  assert.ok(BAMBU_STAGES.length > 60 && BAMBU_STAGES.every(text => typeof text === 'string' && text.trim()));
});

test('message generator mirrors Bambu Studio lookup and merges per-model text compactly', async () => {
  const { sectionTexts, mergeTexts, parseStages } = await import('../../scripts/generate-hms-messages.mjs');
  const table = { data: { device_hms: { ver: 1, en: [
    { ecode: '0300180000010001', intro: 'First text wins.' },
    { ecode: '0300180000010001', intro: 'Later duplicate.' },
    { ecode: '0300180000010002', intro: '' },
    { ecode: '0300180000010002', intro: 'Text after a blank first entry.' },
  ] } } };
  const texts = sectionTexts(table, 'device_hms', /^[0-9A-F]{16}$/);
  assert.equal(texts.get('0300180000010001'), 'First text wins.');
  assert.equal(texts.get('0300180000010002'), '', 'like HMSQuery::_query_hms_msg, the first entry is used even when blank');
  assert.throws(() => sectionTexts({ data: { device_hms: { en: [{ ecode: 'xyz', intro: '' }] } } }, 'device_hms', /^[0-9A-F]{16}$/), /Malformed/);
  assert.throws(() => sectionTexts({ data: {} }, 'device_error', /^[0-9A-F]{8}$/), /no English device_error/);
  const map = (entries) => new Map(Object.entries(entries));
  const merged = mergeTexts({
    '093': map({ A: 'same', B: 'common', C: '' }), '094': map({ A: 'same', B: 'common' }),
    '20P': map({ A: 'same', B: 'X2D wording', C: 'only here' }),
  });
  assert.deepEqual(merged, { A: 'same', B: { '*': 'common', '20P': 'X2D wording' }, C: 'only here' });
  const stages = parseStages('wxString Slic3r::get_stage_string(int stage)\n{\n switch(stage) {\n case 0:\n  return _L("Printing");\n case 1:\n  return _L("Say \\"hi\\"");\n }\n}\n');
  assert.deepEqual(stages, ['Printing', 'Say "hi"']);
  assert.throws(() => parseStages('wxString Slic3r::get_stage_string(int stage)\n{\n case 0:\n return _L("A");\n case 2:\n return _L("C");\n}\n'), /skips or repeats stage 1/);
  assert.throws(() => parseStages('int main() {}'), /no get_stage_string/);
});
