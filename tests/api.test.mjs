import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addItem, cookieHeaderFor, duplicateItem, effectiveAuth, emptyCollection, emptyScopes, findItem, jsonTokens, lookupVar, mergeSecrets, moveItem, newFolder, newKV, newRequest,
  newVariable, normalizeCollection, parseCollectionJson, parseQuery, parseSetCookie, pathVarNames, prepareRequest, prettyJson, prettyXml, resolveVars, serializeCollection,
  setRequestParams, setRequestUrl, splitSecrets, storeCookies, toWire, undefinedVars, varTokens, base64ToBytes, bodyKind, addHistory, historyByDay, formatSize, statusTone,
} from '../src/extensions/api/api.ts';
import {
  exportEnvironment, exportPostman, importAny, importOpenApi, importPostman, importPostmanEnvironment, parseCurl, shellWords, toCurl, toFetch, toPython,
} from '../src/extensions/api/apiFormat.ts';
import { expect as pmExpect, runScript } from '../src/extensions/api/apiScript.ts';
import { runCollection, runRequest, scopeChanges } from '../src/extensions/api/apiRun.ts';
import { applyOps, parseOps, readCollection, requestFromInput, summarizeCollection } from '../src/extensions/api/apiOps.ts';

const scopes = (patch = {}) => ({ ...emptyScopes(), ...patch });
const decode = (b64) => new TextDecoder().decode(base64ToBytes(b64));

test('{{variables}} resolve by scope precedence, nest, and unknown ones are reported', () => {
  const sc = scopes({ globals: { host: 'g.example', who: 'global' }, collection: { who: 'collection', base: 'https://{{host}}/v1' }, environment: { who: 'env', host: 'api.example' }, local: {} });
  assert.equal(resolveVars('{{who}}', sc), 'env');
  assert.equal(lookupVar(sc, 'who').scope, 'environment');
  assert.equal(resolveVars('{{ base }}/users', sc), 'https://api.example/v1/users');
  const missing = new Set();
  assert.equal(resolveVars('{{base}}/{{nope}}', sc, missing), 'https://api.example/v1/{{nope}}');
  assert.deepEqual([...missing], ['nope']);
  assert.match(resolveVars('{{$guid}}', sc), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.match(resolveVars('{{$timestamp}}', sc), /^\d{10}$/);
  const tokens = varTokens('a {{who}} b {{nope}}', sc);
  assert.deepEqual(tokens.map((t) => [t.text, t.defined ?? null, t.scope ?? null]), [['a ', null, null], ['{{who}}', true, 'environment'], [' b ', null, null], ['{{nope}}', false, null]]);
  const r = newRequest({ url: '{{base}}/x?k={{key}}', headers: [newKV('X', '{{hdr}}'), newKV('Off', '{{off}}', false)] });
  setRequestUrl(r, r.url);
  assert.deepEqual(undefinedVars(r, sc).sort(), ['hdr', 'key']);
});

test('params and the URL query stay in sync; path variables come from :segments', () => {
  const r = newRequest();
  setRequestUrl(r, 'https://api.test/users/:id/posts/:postId?page=2&q={{term}}&flag');
  assert.deepEqual(r.params.map((p) => [p.key, p.value]), [['page', '2'], ['q', '{{term}}'], ['flag', '']]);
  assert.deepEqual(r.pathVars.map((p) => p.key), ['id', 'postId']);
  assert.deepEqual(pathVarNames('http://localhost:8080/:a/{{b}}/:c'), ['a', 'c']);
  r.params[0].enabled = false;
  setRequestParams(r, r.params);
  assert.equal(r.url, 'https://api.test/users/:id/posts/:postId?q={{term}}&flag');
  setRequestUrl(r, 'https://api.test/users/:id/posts/:postId?q=x');
  assert.deepEqual(r.params.map((p) => [p.key, p.value, p.enabled]), [['q', 'x', true], ['page', '2', false]]);
  assert.deepEqual(parseQuery('a=1=2&b'), [{ key: 'a', value: '1=2' }, { key: 'b', value: '' }]);
});

test('auth is inherited from folders and the collection; prepared requests carry auth, path values and content types', () => {
  const c = emptyCollection('Shop');
  c.auth = { type: 'bearer', token: '{{token}}' };
  const folder = newFolder('Admin', { auth: { type: 'basic', username: 'ann', password: '{{pw}}' } });
  const inFolder = newRequest({ name: 'Stats', url: '{{base}}/stats' });
  const atRoot = newRequest({ name: 'Me', url: '{{base}}/users/:id' });
  setRequestUrl(atRoot, atRoot.url);
  atRoot.pathVars[0].value = 'a b';
  folder.items.push(inFolder);
  c.items.push(folder, atRoot);
  assert.equal(effectiveAuth(c, inFolder.id).from, 'folder "Admin"');
  assert.equal(effectiveAuth(c, atRoot.id).from, 'collection');
  const sc = scopes({ environment: { base: 'https://shop.test', token: 'T0K', pw: 'pässwörd' } });
  const p1 = prepareRequest(atRoot, sc, effectiveAuth(c, atRoot.id).auth);
  assert.equal(p1.url, 'https://shop.test/users/a%20b');
  assert.deepEqual(p1.headers, [{ key: 'Authorization', value: 'Bearer T0K' }]);
  const p2 = prepareRequest(inFolder, sc, effectiveAuth(c, inFolder.id).auth);
  assert.equal(decode(p2.headers[0].value.replace('Basic ', '')), 'ann:pässwörd');
  const key = newRequest({ url: 'api.test/x?a=1', body: { mode: 'raw', raw: '{"n":{{n}}}', language: 'json', formdata: [], urlencoded: [], file: null } });
  const p3 = prepareRequest(key, scopes({ local: { n: '5' } }), { type: 'apikey', key: 'api_key', value: 's3 cret', in: 'query' });
  assert.equal(p3.url, 'http://api.test/x?a=1&api_key=s3%20cret');
  assert.deepEqual(p3.body, { kind: 'text', text: '{"n":5}' });
  assert.deepEqual(p3.headers, [{ key: 'Content-Type', value: 'application/json' }]);
});

test('form bodies go out as urlencoded text or multipart bytes with a boundary', () => {
  const r = newRequest({ method: 'POST', url: 'https://x.test' });
  r.body = { mode: 'urlencoded', raw: '', language: 'json', urlencoded: [newKV('name', 'Ann Lee'), newKV('x', 'a&b'), newKV('off', '1', false)], formdata: [], file: null };
  const u = toWire(prepareRequest(r, scopes(), { type: 'none' }));
  assert.equal(u.body, 'name=Ann+Lee&x=a%26b');
  assert.deepEqual(u.headers, [{ key: 'Content-Type', value: 'application/x-www-form-urlencoded' }]);
  r.body = { ...r.body, mode: 'formdata', formdata: [{ ...newKV('note', 'hi'), type: 'text' }, { ...newKV('file', ''), type: 'file', fileName: 'a.txt', src: 'data:text/plain;base64,SGVsbG8=' }] };
  const m = toWire(prepareRequest(r, scopes(), { type: 'none' }), 'BOUNDARY');
  assert.deepEqual(m.headers, [{ key: 'Content-Type', value: 'multipart/form-data; boundary=BOUNDARY' }]);
  assert.equal(decode(m.bodyBase64), '--BOUNDARY\r\nContent-Disposition: form-data; name="note"\r\n\r\nhi\r\n--BOUNDARY\r\nContent-Disposition: form-data; name="file"; filename="a.txt"\r\nContent-Type: text/plain\r\n\r\nHello\r\n--BOUNDARY--\r\n');
  r.body = { ...r.body, mode: 'binary', file: { name: 'p.png', src: 'data:image/png;base64,AAEC' } };
  const b = toWire(prepareRequest(r, scopes(), { type: 'none' }));
  assert.equal(b.bodyBase64, 'AAEC');
  assert.deepEqual(b.headers, [{ key: 'Content-Type', value: 'image/png' }]);
});

test('the tree: add, move before/after/inside, refuse moving a folder into itself, duplicate with fresh ids', () => {
  const c = emptyCollection();
  const f = newFolder('F'); const g = newFolder('G');
  const a = newRequest({ name: 'A' }); const b = newRequest({ name: 'B' });
  addItem(c, f); addItem(c, a); addItem(c, b); addItem(c, g, f.id);
  assert.ok(moveItem(c, b.id, a.id, 'before'));
  assert.deepEqual(c.items.map((x) => x.name), ['F', 'B', 'A']);
  assert.ok(moveItem(c, a.id, f.id, 'inside'));
  assert.deepEqual(f.items.map((x) => x.name), ['G', 'A']);
  assert.equal(moveItem(c, f.id, g.id, 'inside'), false);
  const copy = duplicateItem(c, f.id);
  assert.equal(copy.name, 'F Copy');
  assert.notEqual(copy.items[1].id, a.id);
  assert.equal(findItem(c, copy.items[1].id).parent.id, copy.id);
  // normalize repairs duplicate ids and keeps the shape
  const broken = JSON.parse(serializeCollection(c));
  broken.items[0].items[1].id = broken.items[1].id;
  const { value, warnings } = normalizeCollection(broken);
  assert.equal(warnings.length, 1);
  assert.equal(new Set([...JSON.stringify(value).matchAll(/"id":"([^"]+)"/g)].map((m) => m[1])).size, [...JSON.stringify(value).matchAll(/"id":"([^"]+)"/g)].length);
  assert.equal(parseCollectionJson('{not json', 'x').value.name, 'x');
});

test('secret variable values are split out for the local store and merged back', () => {
  const vars = [newVariable('host', 'h'), newVariable('token', 'abc', true), newVariable('empty', '', true)];
  const { pub, secrets } = splitSecrets(vars);
  assert.deepEqual(pub.map((v) => v.value), ['h', '', '']);
  assert.deepEqual(secrets, { token: 'abc' });
  assert.deepEqual(mergeSecrets(pub, secrets).map((v) => v.value), ['h', 'abc', '']);
});

test('cookies: Set-Cookie is parsed, stored by domain and path, and sent back to matching URLs', () => {
  const now = Date.parse('2026-11-27T00:00:00Z');
  const a = parseSetCookie('sid=1; Path=/; HttpOnly', 'https://api.shop.test/login');
  const b = parseSetCookie('pref=dark; Domain=.shop.test; Path=/app; Secure', 'https://api.shop.test/');
  const gone = parseSetCookie('old=x; Expires=Thu, 01 Jan 2026 00:00:00 GMT', 'https://api.shop.test/');
  assert.equal(a.httpOnly, true);
  let jar = storeCookies({}, [a, b, gone], now);
  assert.equal(cookieHeaderFor(jar, 'https://api.shop.test/x', now), 'sid=1');
  assert.equal(cookieHeaderFor(jar, 'https://www.shop.test/app/page', now), 'pref=dark');
  assert.equal(cookieHeaderFor(jar, 'http://www.shop.test/app/page', now), '', 'secure cookies need https');
  jar = storeCookies(jar, [parseSetCookie('sid=; Max-Age=0', 'https://api.shop.test/')], now);
  assert.equal(cookieHeaderFor(jar, 'https://api.shop.test/x', now), '');
});

test('responses: kinds, pretty JSON/XML, JSON tokens, sizes, history', () => {
  const res = (body, type) => ({ status: 200, statusText: 'OK', httpVersion: '1.1', headers: type ? [{ key: 'Content-Type', value: type }] : [], body, encoding: 'utf8', timeMs: 1, timings: {}, bodySize: body.length, headersSize: 0, url: '', redirects: 0, truncated: false });
  assert.equal(bodyKind(res('{"a":1}')), 'json');
  assert.equal(bodyKind(res('<html></html>', 'text/html; charset=utf-8')), 'html');
  assert.equal(bodyKind({ ...res('AAA', 'image/png'), encoding: 'base64' }), 'image');
  assert.equal(prettyJson('{"a":[1,true,null]}'), '{\n  "a": [\n    1,\n    true,\n    null\n  ]\n}');
  assert.equal(prettyXml('<a><b>1</b><c/></a>'), '<a>\n  <b>1</b>\n  <c/>\n</a>');
  assert.deepEqual(jsonTokens('{"k": "v", "n": -1.5}').filter((t) => t.kind !== 'space' && t.kind !== 'punct').map((t) => t.kind), ['key', 'string', 'key', 'number']);
  assert.equal(formatSize(2048), '2.00 KB');
  assert.equal(statusTone(404), 'client');
  let h = [];
  for (let i = 0; i < 5; i++) h = addHistory(h, { id: String(i), at: new Date(Date.UTC(2026, 10, 27, 10, i)).toISOString(), method: 'GET', url: 'u', status: 200, timeMs: 1, size: 1, request: newRequest() }, 3);
  assert.deepEqual(h.map((e) => e.id), ['4', '3', '2']);
  assert.equal(historyByDay(h, Date.UTC(2026, 10, 27, 12))[0].label, 'Today');
});

test('cURL commands are parsed (quotes, continuations, data, forms, auth) and exported back', () => {
  assert.deepEqual(shellWords(`curl -H 'A: b c' "x\\"y" $'l\\n2' \\\n  --url=u`), ['curl', '-H', 'A: b c', 'x"y', 'l\n2', '--url=u']);
  const r = parseCurl(`curl -X PUT 'https://api.test/items/7?full=1' \\
    -H 'Content-Type: application/json' -H "Authorization: Bearer abc" \\
    --data-raw '{"name":"Ann"}' -L -k --max-time 5`);
  assert.equal(r.method, 'PUT');
  assert.equal(r.url, 'https://api.test/items/7?full=1');
  assert.deepEqual(r.params.map((p) => [p.key, p.value]), [['full', '1']]);
  assert.deepEqual(r.headers.map((h) => [h.key, h.value]), [['Authorization', 'Bearer abc']]);
  assert.deepEqual([r.body.mode, r.body.language, r.body.raw], ['raw', 'json', '{"name":"Ann"}']);
  assert.deepEqual(r.settings, { timeoutMs: 5000, followRedirects: true, verifyTls: false });
  const form = parseCurl('curl https://x.test -u ann:pw -d name=Ann%20Lee -d age=3');
  assert.equal(form.method, 'POST');
  assert.deepEqual(form.auth, { type: 'basic', username: 'ann', password: 'pw' });
  assert.deepEqual(form.body.urlencoded.map((f) => [f.key, f.value]), [['name', 'Ann Lee'], ['age', '3']]);
  const multi = parseCurl('curl.exe https://x.test -F "file=@C:/tmp/a.png" -F note=hi');
  assert.deepEqual(multi.body.formdata.map((f) => [f.key, f.type, f.fileName ?? f.value]), [['file', 'file', 'a.png'], ['note', 'text', 'hi']]);
  assert.equal(parseCurl('curl -G https://x.test -d q=1').url, 'https://x.test?q=1');
  assert.equal(parseCurl('curl --json \'{"a":1}\' https://x.test').headers.find((h) => h.key === 'Accept').value, 'application/json');
  assert.throws(() => parseCurl('wget https://x'), /not a cURL/);

  const prepared = prepareRequest(r, scopes(), { type: 'none' });
  const curl = toCurl(prepared);
  assert.match(curl, /^curl --location --request PUT 'https:\/\/api\.test\/items\/7\?full=1'/);
  assert.match(curl, /--data-raw '\{"name":"Ann"\}'/);
  const again = parseCurl(curl);
  assert.deepEqual([again.method, again.url, again.body.raw], ['PUT', r.url, r.body.raw]);
  assert.match(toCurl(prepareRequest(newRequest({ url: "https://x.test/it's" }), scopes(), { type: 'none' })), /'https:\/\/x\.test\/it'\\''s'/);
  assert.match(toFetch(prepared), /fetch\("https:\/\/api\.test\/items\/7\?full=1", requestOptions\)/);
  assert.match(toFetch(prepared), /const body = JSON\.stringify\(\{\n {2}"name": "Ann"\n\}\);/);
  assert.match(toPython(prepared), /response = requests\.request\('PUT', url, headers=headers, data=payload\)/);
});

test('Postman v2.1 collections and environments import, and export back to the same shape', () => {
  const postman = {
    info: { name: 'Pets', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json', description: 'Pet store' },
    auth: { type: 'bearer', bearer: [{ key: 'token', value: '{{token}}' }] },
    variable: [{ key: 'baseUrl', value: 'https://pets.test' }, { key: 'secret', value: 's', type: 'secret' }],
    event: [{ listen: 'prerequest', script: { exec: ['pm.variables.set("x", 1);'] } }],
    item: [
      { name: 'Pets', item: [
        { name: 'List pets', request: { method: 'GET', header: [{ key: 'Accept', value: 'application/json' }, { key: 'X-Off', value: '1', disabled: true }], url: { raw: '{{baseUrl}}/pets?limit=10', host: ['{{baseUrl}}'], path: ['pets'], query: [{ key: 'limit', value: '10' }, { key: 'tag', value: 'cat', disabled: true }] } },
          event: [{ listen: 'test', script: { exec: ['pm.test("ok", () => pm.response.to.have.status(200));'] } }] },
        { name: 'Get pet', request: { method: 'GET', url: { raw: '{{baseUrl}}/pets/:id', variable: [{ key: 'id', value: '7' }] }, auth: { type: 'noauth' } } },
      ] },
      { name: 'Create', request: { method: 'POST', url: '{{baseUrl}}/pets', body: { mode: 'raw', raw: '{"name":"Rex"}', options: { raw: { language: 'json' } } } } },
      { name: 'Login', request: { method: 'POST', url: '{{baseUrl}}/login', body: { mode: 'urlencoded', urlencoded: [{ key: 'user', value: 'ann' }] }, auth: { type: 'basic', basic: [{ key: 'username', value: 'ann' }, { key: 'password', value: 'pw' }] } } },
    ],
  };
  const c = importPostman(postman);
  assert.equal(c.name, 'Pets');
  assert.deepEqual(c.auth, { type: 'bearer', token: '{{token}}' });
  assert.equal(c.variables[1].secret, true);
  assert.equal(c.preRequest, 'pm.variables.set("x", 1);');
  const list = c.items[0].items[0];
  assert.deepEqual(list.params.map((p) => [p.key, p.enabled]), [['limit', true], ['tag', false]]);
  assert.deepEqual(list.headers.map((h) => [h.key, h.enabled]), [['Accept', true], ['X-Off', false]]);
  assert.match(list.tests, /have\.status\(200\)/);
  assert.deepEqual(c.items[0].items[1].pathVars.map((p) => [p.key, p.value]), [['id', '7']]);
  assert.equal(c.items[0].items[1].auth.type, 'none');
  assert.equal(c.items[0].items[0].auth.type, 'inherit');
  assert.deepEqual([c.items[1].body.mode, c.items[1].body.language], ['raw', 'json']);
  assert.deepEqual(c.items[2].auth, { type: 'basic', username: 'ann', password: 'pw' });

  const out = exportPostman(c);
  assert.equal(out.info.schema, postman.info.schema);
  assert.equal(out.variable[1].value, '', 'secret values are not exported');
  const back = importPostman(JSON.parse(JSON.stringify(out)));
  const strip = (x) => JSON.parse(JSON.stringify(x, (k, v) => (k === 'id' ? undefined : v)));
  assert.deepEqual(strip(back.items), strip(c.items));
  assert.equal(importAny(JSON.stringify(postman)).format, 'Postman Collection v2.1');

  const env = importPostmanEnvironment({ name: 'Dev', values: [{ key: 'baseUrl', value: 'http://localhost', enabled: true }, { key: 'token', value: 't', type: 'secret', enabled: true }] });
  assert.deepEqual(env.values.map((v) => [v.key, !!v.secret]), [['baseUrl', false], ['token', true]]);
  assert.equal(exportEnvironment(env).values[1].value, '');
  assert.equal(importAny(JSON.stringify({ name: 'E', values: [] })).kind, 'environment');
  assert.equal(importAny('curl https://x.test').kind, 'request');
  assert.throws(() => importAny('{"a":1}'), /not a Postman collection/);
});

test('OpenAPI 3 imports as folders per tag with baseUrl, params, example bodies, auth and status tests', () => {
  const doc = {
    openapi: '3.0.3', info: { title: 'Petstore', version: '1.0' },
    servers: [{ url: 'https://{env}.pets.test/v1/', variables: { env: { default: 'api' } } }],
    security: [{ bearer: [] }],
    components: {
      securitySchemes: { bearer: { type: 'http', scheme: 'bearer' }, key: { type: 'apiKey', in: 'header', name: 'X-Key' } },
      schemas: { Pet: { type: 'object', properties: { id: { type: 'integer' }, name: { type: 'string', example: 'Rex' }, tags: { type: 'array', items: { type: 'string' } }, owner: { $ref: '#/components/schemas/Owner' } } }, Owner: { type: 'object', properties: { email: { type: 'string', format: 'email' }, pet: { $ref: '#/components/schemas/Pet' } } } },
    },
    tags: [{ name: 'pets', description: 'Everything about pets' }],
    paths: {
      '/pets': {
        get: { tags: ['pets'], summary: 'List pets', parameters: [{ name: 'limit', in: 'query', required: true, schema: { type: 'integer', default: 20 } }, { name: 'tag', in: 'query', schema: { type: 'string' } }, { name: 'X-Trace', in: 'header', schema: { type: 'string' } }], responses: { 200: { description: 'ok' } } },
        post: { tags: ['pets'], operationId: 'createPet', requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Pet' } } } }, responses: { 201: { description: 'created' } }, security: [{ key: [] }] },
      },
      '/pets/{petId}': { parameters: [{ name: 'petId', in: 'path', required: true, example: 7 }], delete: { summary: 'Delete', security: [] } },
      '/health': { get: { summary: 'Health' } },
    },
  };
  const c = importOpenApi(doc);
  assert.equal(c.name, 'Petstore');
  assert.deepEqual(c.variables.map((v) => [v.key, v.value, !!v.secret]), [['baseUrl', 'https://api.pets.test/v1', false], ['bearerToken', '', true], ['apiKey', '', true]]);
  assert.deepEqual(c.auth, { type: 'bearer', token: '{{bearerToken}}' });
  const pets = c.items[0];
  assert.equal(pets.name, 'pets');
  assert.equal(pets.description, 'Everything about pets');
  const [list, create] = pets.items;
  assert.equal(list.url, '{{baseUrl}}/pets?limit=20');
  assert.deepEqual(list.params.map((p) => [p.key, p.value, p.enabled]), [['limit', '20', true], ['tag', '', false]]);
  assert.deepEqual(list.headers.map((h) => h.key), ['X-Trace']);
  assert.match(list.tests, /status\(200\)/);
  assert.equal(create.name, 'createPet');
  assert.deepEqual(JSON.parse(create.body.raw), { id: 0, name: 'Rex', tags: ['string'], owner: { email: 'user@example.com', pet: {} } });
  assert.deepEqual(create.auth, { type: 'apikey', key: 'X-Key', value: '{{apiKey}}', in: 'header' });
  const del = c.items[1];
  assert.equal(del.url, '{{baseUrl}}/pets/:petId');
  assert.deepEqual(del.pathVars.map((p) => [p.key, p.value]), [['petId', '7']]);
  assert.equal(del.auth.type, 'none');
  assert.equal(c.items[2].name, 'Health');
  assert.equal(importAny(JSON.stringify({ swagger: '2.0', host: 'h.test', basePath: '/api', schemes: ['http'], paths: { '/a': { get: {} } } })).collection.variables[0].value, 'http://h.test/api');
});

const response = (patch = {}) => ({ code: 200, status: 'OK', headers: [{ key: 'Content-Type', value: 'application/json' }], body: '{"id":7,"name":"Rex","tags":["a","b"],"nested":{"x":[1,2]}}', responseTime: 42, responseSize: 60, cookies: [{ name: 'sid', value: '1' }], ...patch });
const script = (code, extra = {}) => runScript({ code, event: 'test', request: { method: 'GET', url: 'https://x.test/a?b=1', headers: [], body: { mode: 'none', raw: '' } }, response: response(), scopes: scopes(), ...extra });

test('scripts: pm.test with pm.expect and pm.response assertions record passes and failures', async () => {
  const out = await script(`
    pm.test("status", () => pm.response.to.have.status(200));
    pm.test("ok + json", () => { pm.response.to.be.ok; pm.response.to.be.json; pm.response.to.have.header("content-type", "application/json"); });
    pm.test("body", () => {
      const d = pm.response.json();
      pm.expect(d.id).to.equal(7);
      pm.expect(d).to.have.property("name", "Rex");
      pm.expect(d.tags).to.have.lengthOf(2).and.include("a");
      pm.expect(d).to.deep.include({ name: "Rex" });
      pm.expect(d).to.have.nested.property("nested.x[1]", 2);
      pm.expect(d.name).to.be.a("string").that.matches;
      pm.expect(pm.response.responseTime).to.be.below(500);
      pm.expect([1, 2]).to.eql([1, 2]);
      pm.expect(null).to.not.exist;
      pm.expect("x").to.be.oneOf(["x", "y"]);
      pm.response.to.have.jsonBody("nested.x", [1, 2]);
    });
    pm.test("fails", () => pm.expect(pm.response.code).to.equal(201));
    pm.test("async", async () => { await null; pm.expect(1).to.be.above(2); });
    pm.test.skip("later");
    tests["legacy"] = responseCode.code === 200;
    console.log("seen", pm.cookies.get("sid"), { a: 1 });
  `);
  assert.equal(out.error, undefined);
  assert.deepEqual(out.tests.map((t) => [t.name, t.passed]), [['status', true], ['ok + json', true], ['body', true], ['fails', false], ['async', false], ['later', true], ['legacy', true]]);
  assert.equal(out.tests[3].error, 'AssertionError: expected 200 to equal 201');
  assert.equal(out.tests[4].error, 'AssertionError: expected 1 to be above 2');
  assert.equal(out.tests[5].skipped, true);
  assert.deepEqual(out.logs, [{ level: 'log', text: 'seen 1 {"a":1}' }]);
  assert.throws(() => pmExpect(3).to.not.be.within(1, 5), /not to be within/);
});

test('scripts: variables are set and read across scopes, the request can be changed, errors are reported', async () => {
  const pre = await runScript({
    code: `
      pm.environment.set("token", "abc");
      pm.collectionVariables.set("n", 3);
      pm.globals.unset("old");
      pm.variables.set("local", "L");
      pm.request.headers.add({ key: "X-Id", value: pm.variables.get("local") });
      pm.request.headers.upsert({ key: "Accept", value: "text/plain" });
      pm.request.url.query.add("c=3");
      pm.request.body.raw = JSON.stringify({ t: pm.environment.get("token") });
      if (pm.variables.replaceIn("{{token}}-{{n}}") !== "abc-3") throw new Error("replaceIn");
    `,
    event: 'prerequest', request: { method: 'POST', url: 'https://x.test/a', headers: [{ key: 'Accept', value: '*/*' }], body: { mode: 'none', raw: '' } },
    scopes: scopes({ globals: { old: '1', keep: '2' } }),
  });
  assert.equal(pre.error, undefined);
  assert.deepEqual(pre.scopes, { globals: { keep: '2' }, collection: { n: '3' }, environment: { token: 'abc' }, local: { local: 'L' } });
  assert.deepEqual(pre.request.headers.map((h) => [h.key, h.value]), [['Accept', 'text/plain'], ['X-Id', 'L']]);
  assert.equal(pre.request.url, 'https://x.test/a?c=3');
  assert.deepEqual(pre.request.body, { mode: 'raw', raw: '{"t":"abc"}' });
  const noEnv = await script('pm.environment.set("a", 1);', { hasEnvironment: false });
  assert.deepEqual(noEnv.scopes.environment, {});
  assert.match(noEnv.logs[0].text, /no environment is selected/);
  const bad = await script('pm.test("before", () => {}); pm.response.json(); undefinedThing();', { response: response({ body: 'not json' }) });
  assert.match(bad.error, /JSONError/);
  assert.equal(bad.tests.length, 1);
  const syntax = await script('pm.test("x", () => {');
  assert.match(syntax.error, /SyntaxError/);
});

test('scripts cannot reach the page, the network or node by name', async () => {
  const out = await script(`
    const seen = [typeof window, typeof document, typeof fetch, typeof XMLHttpRequest, typeof globalThis, typeof process, typeof require, typeof __TAURI_INTERNALS__, typeof localStorage, typeof self];
    pm.test("isolated", () => pm.expect(seen.every((t) => t === "undefined")).to.be.true);
    pm.test("no sendRequest", () => pm.expect(() => pm.sendRequest("https://x")).to.throw("not available"));
  `);
  assert.deepEqual(out.tests.map((t) => [t.name, t.passed, t.error]), [['isolated', true, undefined], ['no sendRequest', true, undefined]]);
});

const fakeSend = (calls, answer) => async (req) => { calls.push(req); return answer(req); };
const okResponse = (body, headers = [{ key: 'Content-Type', value: 'application/json' }]) => ({ status: 200, statusText: 'OK', httpVersion: '1.1', headers, body, encoding: 'utf8', timeMs: 12, timings: { dnsMs: 0, connectMs: 0, tlsMs: 0, firstByteMs: 0, totalMs: 12 }, bodySize: body.length, headersSize: 10, url: 'https://shop.test/login', redirects: 0, truncated: false });

test('runRequest: collection → folder → request scripts, variables, auth and cookies around one send', async () => {
  const c = emptyCollection('Shop');
  c.auth = { type: 'bearer', token: '{{token}}' };
  c.preRequest = 'pm.variables.set("trace", "t-1");';
  c.tests = 'pm.test("collection: 2xx", () => pm.response.to.be.ok);';
  const folder = newFolder('Auth', { preRequest: 'pm.request.headers.add({ key: "X-Trace", value: pm.variables.get("trace") });' });
  const login = newRequest({ name: 'Login', method: 'POST', url: '{{base}}/login', tests: 'pm.environment.set("token", pm.response.json().token);\npm.test("has token", () => pm.expect(pm.response.json()).to.have.property("token"));' });
  folder.items.push(login);
  c.items.push(folder);
  const calls = [];
  const send = fakeSend(calls, () => okResponse('{"token":"NEW"}', [{ key: 'Content-Type', value: 'application/json' }, { key: 'Set-Cookie', value: 'sid=9; Path=/' }]));
  const r = await runRequest({ collection: c, request: login, scopes: scopes({ environment: { base: 'https://shop.test', token: 'OLD' } }), hasEnvironment: true, send, runScript, jar: {} });
  assert.equal(r.error, undefined);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://shop.test/login');
  assert.deepEqual(calls[0].headers, [{ key: 'X-Trace', value: 't-1' }, { key: 'Authorization', value: 'Bearer OLD' }]);
  assert.deepEqual(r.tests.map((t) => [t.name, t.passed]), [['collection: 2xx', true], ['has token', true]]);
  assert.equal(r.scopes.environment.token, 'NEW');
  assert.deepEqual(scopeChanges({ token: 'OLD', base: 'https://shop.test' }, r.scopes.environment), { set: { token: 'NEW' }, unset: [] });
  // the cookie jar sends sid on the next request
  const again = await runRequest({ collection: c, request: login, scopes: r.scopes, hasEnvironment: true, send, runScript, jar: r.jar });
  assert.equal(calls[1].headers.find((h) => h.key === 'Cookie').value, 'sid=9');
  assert.equal(calls[1].headers.find((h) => h.key === 'Authorization').value, 'Bearer NEW');
  assert.equal(again.error, undefined);
  // a failing pre-request script stops the send; a transport error is returned
  const broken = newRequest({ url: 'https://x.test', preRequest: 'throw new Error("boom")' });
  const b = await runRequest({ collection: emptyCollection(), request: broken, scopes: scopes(), hasEnvironment: false, send, runScript });
  assert.equal(b.stage, 'prerequest');
  assert.match(b.error, /request pre-request script: Error: boom/);
  assert.equal(calls.length, 2);
  const down = await runRequest({ collection: emptyCollection(), request: newRequest({ url: 'https://x.test' }), scopes: scopes(), hasEnvironment: false, send: async () => { throw new Error('Could not connect'); }, runScript });
  assert.deepEqual([down.stage, down.error], ['send', 'Could not connect']);
  const unresolved = await runRequest({ collection: emptyCollection(), request: newRequest({ url: '{{nowhere}}/x' }), scopes: scopes(), hasEnvironment: false, send, runScript });
  assert.match(unresolved.error, /not defined: \{\{nowhere\}\}/);
});

test('runCollection runs requests in order and follows pm.setNextRequest', async () => {
  const a = newRequest({ name: 'A', url: 'https://x.test/a', tests: 'pm.setNextRequest("C");' });
  const b = newRequest({ name: 'B', url: 'https://x.test/b' });
  const cReq = newRequest({ name: 'C', url: 'https://x.test/c', tests: 'pm.test("c", () => pm.expect(pm.response.code).to.equal(200)); pm.setNextRequest(null);' });
  const calls = [];
  const out = await runCollection({ collection: emptyCollection(), requests: [a, b, cReq], scopes: scopes(), hasEnvironment: false, send: fakeSend(calls, () => okResponse('{}')), runScript });
  assert.deepEqual(out.steps.map((s) => s.name), ['A', 'C']);
  assert.deepEqual(calls.map((c) => c.url), ['https://x.test/a', 'https://x.test/c']);
  assert.equal(out.steps[1].tests[0].passed, true);
});

test('agent ops edit a collection all-or-nothing and the reader shows ids, auth and bodies', () => {
  const c = emptyCollection('Users API');
  const { ops, errors } = parseOps([
    { op: 'set_variable', key: 'baseUrl', value: 'https://users.test' },
    { op: 'set_variable', key: 'token', value: 'abc', secret: true },
    { op: 'set_auth', auth: { type: 'bearer', token: '{{token}}' } },
    { op: 'add_folder', name: 'Users' },
    { op: 'add_request', parent: 'Users', name: 'List users', url: '{{baseUrl}}/users?page=1', headers: { Accept: 'application/json' }, tests: 'pm.test("200", () => pm.response.to.have.status(200));' },
    { op: 'add_request', parent: 'Users', name: 'Get user', url: '{{baseUrl}}/users/:id', path_vars: { id: '42' } },
    { op: 'add_request', name: 'Create user', method: 'post', url: '{{baseUrl}}/users', body: { json: { name: 'Ann' } }, auth: { type: 'apikey', key: 'X-Key', value: '{{k}}' } },
    { op: 'update_request', id: 'List users', params: [{ key: 'page', value: '2' }, { key: 'size', value: '10' }], add_headers: ['X-Trace: 1'] },
    { op: 'move', id: 'Create user', into: 'Users' },
    { op: 'duplicate', id: 'Get user' },
    { op: 'rename', id: 'Get user Copy', name: 'Get user (admin)' },
  ]);
  assert.deepEqual(errors, []);
  const r = applyOps(c, ops);
  assert.equal(r.error, undefined, r.error);
  assert.equal(r.created.length, 5);
  const out = r.collection;
  const users = out.items[0];
  assert.deepEqual(users.items.map((x) => x.name), ['List users', 'Get user', 'Get user (admin)', 'Create user']);
  assert.equal(users.items[0].url, '{{baseUrl}}/users?page=2&size=10');
  assert.deepEqual(users.items[0].headers.map((h) => h.key), ['Accept', 'X-Trace']);
  assert.deepEqual(users.items[1].pathVars.map((p) => [p.key, p.value]), [['id', '42']]);
  assert.deepEqual([users.items[3].method, users.items[3].body.mode, JSON.parse(users.items[3].body.raw).name], ['POST', 'raw', 'Ann']);
  assert.equal(out.variables[1].secret, true);
  const text = readCollection(out);
  assert.match(text, /"Users API": 4 request\(s\) in 1 folder\(s\)/);
  assert.match(text, /token=\(secret\)/);
  assert.match(text, /GET \{\{baseUrl\}\}\/users\?page=2&size=10 — List users \[tests\]/);
  const one = readCollection(out, 'Users / Get user');
  assert.match(one, /auth: inherit → Bearer \{\{token\}\} \(from collection\)/);
  assert.match(readCollection(out, users.items[3].id), /body: raw json:\n\{\n {2}"name": "Ann"\n\}/);
  assert.match(summarizeCollection(out), /4 request/);

  // all-or-nothing: a bad op leaves the input untouched
  const bad = applyOps(out, [{ op: 'delete', id: 'List users' }, { op: 'add_request', parent: 'Nope', url: 'x' }]);
  assert.match(bad.error, /op 2 \(add_request\): no folder "Nope"/);
  assert.equal(bad.collection, out);
  assert.equal(findItem(out, users.items[0].id).item.name, 'List users');
  assert.match(parseOps([{ op: 'explode' }]).errors[0], /unknown op "explode"/);
  assert.match(applyOps(out, [{ op: 'add_request', url: 'x', path_vars: { nope: 1 } }]).error, /not :segments/);
  assert.match(applyOps(out, [{ op: 'set_auth', auth: { type: 'inherit' } }]).error, /cannot inherit/);
  const adhoc = requestFromInput({ method: 'DELETE', url: 'https://x.test/a/:id', path_vars: { id: '1' }, headers: ['A: b'] });
  assert.deepEqual([adhoc.method, adhoc.pathVars[0].value, adhoc.headers[0].key], ['DELETE', '1', 'A']);
});
