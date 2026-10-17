import { stripTypeScriptTypes } from 'node:module'
import { readFileSync } from 'node:fs'

const sample = readFileSync(process.argv[2], 'utf8')
try {
  const out = stripTypeScriptTypes(sample, { mode: 'strip', sourceUrl: process.argv[2] })
  console.log('OK bytes=' + out.length)
} catch (error) {
  console.error('FAIL ' + error.message)
  process.exitCode = 1
}
