#!/usr/bin/env node
/**
 * Minimal ASAR reader: list or extract files from Electron's app.asar.
 * Usage:
 *   node scripts/asar-tool.mjs list <asar> [prefix]
 *   node scripts/asar-tool.mjs extract <asar> <internal-path> <out-file>
 */
import { openSync, readSync, writeFileSync, closeSync, statSync } from 'node:fs'

const [, , cmd, asarPath, ...rest] = process.argv
if (!cmd || !asarPath) {
  console.error('usage: asar-tool.mjs list <asar> [prefix] | extract <asar> <internal> <out>')
  process.exit(2)
}

const fd = openSync(asarPath, 'r')
function readAt(pos, len) {
  const buf = Buffer.alloc(len)
  readSync(fd, buf, 0, len, pos)
  return buf
}

// Header: 8 bytes = [uint32 4][uint32 pickleSize]; pickle: [uint32 payloadSize][uint32 headerStringSize][json]
const sizeBuf = readAt(0, 8)
const pickleSize = sizeBuf.readUInt32LE(4)
const headerPickle = readAt(8, pickleSize)
const headerStringSize = headerPickle.readUInt32LE(4)
const headerJson = headerPickle.subarray(8, 8 + headerStringSize).toString('utf8')
const header = JSON.parse(headerJson)
const baseOffset = 8 + pickleSize

function walk(node, prefix, out) {
  for (const [name, child] of Object.entries(node.files ?? {})) {
    const p = prefix ? `${prefix}/${name}` : name
    if (child.files) walk(child, p, out)
    else if (child.link) out.push({ path: p, link: child.link })
    else if (child.unpacked) out.push({ path: p, unpacked: true, size: child.size })
    else out.push({ path: p, offset: child.offset, size: child.size })
  }
}

if (cmd === 'list') {
  const prefix = rest[0] ?? ''
  const out = []
  walk(header, '', out)
  for (const f of out) {
    if (!prefix || f.path.startsWith(prefix)) console.log(f.path)
  }
} else if (cmd === 'extract') {
  const internal = rest[0]
  const dest = rest[1]
  const out = []
  walk(header, '', out)
  const hit = out.find((f) => f.path === internal)
  if (!hit) {
    console.error('not found:', internal)
    process.exit(1)
  }
  if (hit.unpacked) {
    console.error('file is unpacked (not in asar):', internal)
    process.exit(1)
  }
  const buf = readAt(baseOffset + Number(hit.offset), Number(hit.size))
  writeFileSync(dest, buf)
  console.log(`extracted ${internal} (${hit.size} bytes) -> ${dest}`)
} else {
  console.error('unknown command', cmd)
  process.exit(2)
}
closeSync(fd)
