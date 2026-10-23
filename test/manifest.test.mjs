import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

let passed = 0
function test(label, fn) {
  fn()
  passed += 1
  console.log(`ok ${passed} - ${label}`)
}

test('manifest declares the bundle patch and a client half', () => {
  assert.equal(manifest.type, 'module')
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(manifest.dsh.client.platform, 'web')
  assert.equal(manifest.dsh.client.immediately, true)
  assert.ok(Array.isArray(manifest.dsh.client.inject))
  assert.ok(manifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-conversation'))
})

test('exports expose the client entry, locales and icon', () => {
  assert.equal(manifest.exports['.'], './index.js')
  assert.equal(manifest.exports['./client'], './client.js')
  assert.ok(Object.keys(manifest.exports).includes('./locale/*.json'))
  assert.equal(manifest.exports['./icon'], './icon.svg')
})

test('files list ships every runtime artifact', () => {
  for (const entry of ['index.js', 'client.js', 'cordis.patch.yml', 'locale/*.json', 'icon.svg', 'README.md', 'LICENSE']) {
    assert.ok(manifest.files.includes(entry), `files is missing ${entry}`)
  }
})

test('every file referenced by the manifest exists', () => {
  for (const path of ['index.js', 'client.js', 'cordis.patch.yml', 'icon.svg', 'README.md', 'LICENSE']) {
    assert.ok(existsSync(join(root, path)), `${path} does not exist`)
  }
})

test('the bundle patch inserts the package itself (id + name)', () => {
  const patch = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')
  assert.match(patch, /insert:/)
  assert.match(patch, /id:\s*btw/)
  // The row name MUST be the package name; a mismatch mounts nothing.
  assert.ok(
    patch.includes(`name: '${manifest.name}'`) || patch.includes(`name: ${manifest.name}`),
    `patch name does not match package name ${manifest.name}`,
  )
})

test('the client half registers under the package name', () => {
  const client = readFileSync(join(root, 'client.js'), 'utf8')
  const id = client.match(/__ModuleLoader__\.load\(\{\s*\n\s*id:\s*'([^']+)'/)
  assert.ok(id, 'client.js does not declare a module id')
  // Client module id === package name, otherwise the module graph never mounts it.
  assert.equal(id[1], manifest.name)
})

test('the client half declares the services it uses', () => {
  const client = readFileSync(join(root, 'client.js'), 'utf8')
  assert.match(client, /inject:\s*\[[^\]]*'slots'/)
  // `remote.commands` powers the inline follow-up; without the inject the
  // call throws and the panel stalls.
  assert.match(client, /inject:\s*\[[^\]]*'remote'/)
  assert.match(client, /inject:\s*\[[^\]]*'remote\.commands'/)
})

test('the host half keeps the Config schema and the answer route', () => {
  const host = readFileSync(join(root, 'index.js'), 'utf8')
  assert.match(host, /export const Config = Schema\.object/)
  assert.match(host, /path: '\/btw\/answer'/)
  assert.match(host, /cancel/)
})

test('the package declares the schemastery dependency it imports', () => {
  const host = readFileSync(join(root, 'index.js'), 'utf8')
  if (host.includes("from '@deepseek-ai/schemastery'")) {
    assert.ok(manifest.dependencies && manifest.dependencies['@deepseek-ai/schemastery'],
      'index.js imports @deepseek-ai/schemastery but package.json does not depend on it')
  }
})

console.log(`\n${passed} manifest checks passed (${manifest.name}@${manifest.version})`)
