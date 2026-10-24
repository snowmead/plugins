// exampleProblems in a process of its own, which checkExamples stops when it
// runs too long. Reads {text, file} as JSON on stdin; writes the result as
// JSON on stdout.

import { exampleProblems } from './settings.ts'

const { text, file } = JSON.parse(await Bun.stdin.text())
process.stdout.write(JSON.stringify(exampleProblems(text, file)))
