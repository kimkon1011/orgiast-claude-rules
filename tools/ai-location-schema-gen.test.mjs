// X-0055: Location/Service/Person schema generation tests
import { describe, it } from 'node:test';
import { ok, deepStrictEqual, match } from 'node:assert';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { join } from 'node:path';

const modPath = fileURLToPath(new URL('./ai-location-schema-gen.mjs', import.meta.url));

function runTool(...args) {
  const result = execSync(`node "${modPath}" ${args.join(' ')}`, { encoding: 'utf-8' });
  return JSON.parse(result.trim());
}

await describe('ai-location-schema-gen', async () => {

  await it('location --slug osaka generates LocalBusiness with areaServed', () => {
    const schemas = runTool('location', '--slug', 'osaka');
    ok(Array.isArray(schemas), 'output is array');
    ok(schemas.length >= 1, 'has at least one schema');

    const lb = schemas[0];
    deepStrictEqual(lb['@type'], 'LocalBusiness');
    deepStrictEqual(lb.name, '株式会社オージャスト');
    deepStrictEqual(lb.areaServed['@type'], 'City');
    deepStrictEqual(lb.areaServed.name, '大阪市');
    deepStrictEqual(lb.areaServed.sameAs, 'https://www.wikidata.org/wiki/Q35765');
    ok(lb.hasOfferCatalog.itemListElement.length >= 3, 'has 3+ offers');
  });

  await it('location --slug tokyo generates correct city', () => {
    const schemas = runTool('location', '--slug', 'tokyo');
    const lb = schemas[0];
    deepStrictEqual(lb.areaServed.name, '東京都');
    deepStrictEqual(lb.areaServed.sameAs, 'https://www.wikidata.org/wiki/Q1490');
  });

  await it('location --slug unknown exits with error', () => {
    try {
      runTool('location', '--slug', 'unknown-city');
      ok(false, 'should have thrown');
    } catch (e) {
      ok(e.stderr.includes('unknown'), 'error message mentions unknown');
    }
  });

  await it('service --slug booth-construction generates Service schema', () => {
    const svc = runTool('service', '--slug', 'booth-construction');
    deepStrictEqual(svc['@type'], 'Service');
    deepStrictEqual(svc.name, '展示会ブース設計・施工');
    deepStrictEqual(svc.provider.name, '株式会社オージャスト');
    ok(svc.areaServed.length >= 7, 'serves 7+ cities');
    ok(svc.hasOfferCatalog.itemListElement.length >= 3, 'has 3+ offers');
  });

  await it('service --slug event-planning generates correct name', () => {
    const svc = runTool('service', '--slug', 'event-planning');
    deepStrictEqual(svc.name, '社内イベントプロデュース');
  });

  await it('person --slug kim generates Person schema', () => {
    const person = runTool('person', '--slug', 'kim');
    deepStrictEqual(person['@type'], 'Person');
    deepStrictEqual(person.name, '金 功勇');
    deepStrictEqual(person.jobTitle, '代表取締役');
    deepStrictEqual(person.worksFor.name, '株式会社オージャスト');
    ok(person.knowsAbout.length >= 3, 'knows 3+ subjects');
  });

  await it('all generates all schemas', () => {
    const schemas = runTool('all');
    ok(Array.isArray(schemas.locations));
    ok(schemas.locations.length === 7, '7 location pages');
    ok(Array.isArray(schemas.services));
    ok(schemas.services.length === 3, '3 services');
    ok(Array.isArray(schemas.persons));
    ok(schemas.persons.length === 1, '1 person');
  });

  await it('--help exits cleanly', () => {
    try {
      runTool('--help');
      ok(false, 'should have thrown');
    } catch (e) {
      ok(true, 'exits');
    }
  });

  await it('no args shows help and exits', () => {
    try {
      runTool();
      ok(false, 'should have thrown');
    } catch (e) {
      ok(true, 'exits');
    }
  });
});