import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  buildCourseScopedPath,
  readRememberedCourseId,
  rememberCourseId,
} from '../src/lib/courseContext'

function memoryStorage() {
  const values = new Map<string, string>()
  return {
    getItem(key: string) {
      return values.get(key) ?? null
    },
    setItem(key: string, value: string) {
      values.set(key, value)
    },
  }
}

test('course-scoped reader and library paths retain the exact course', () => {
  assert.equal(buildCourseScopedPath('/pdf', 'course A'), '/pdf?course=course%20A')
  assert.equal(buildCourseScopedPath('/library', 'course A'), '/library?course=course%20A')
  assert.equal(buildCourseScopedPath('/pdf?file=file-1', 'course A'), '/pdf?file=file-1&course=course%20A')
})

test('the active course survives navigation and refresh within the tab', () => {
  const storage = memoryStorage()
  assert.equal(readRememberedCourseId(storage), null)
  assert.equal(rememberCourseId(' course-physics ', storage), 'course-physics')
  assert.equal(readRememberedCourseId(storage), 'course-physics')
})

test('reader synchronizes a restored file course back into the URL', () => {
  const source = readFileSync('src/pages/PdfWorkspacePage.tsx', 'utf8')
  assert.match(source, /next\.set\('course', knowledgeCourseId\)/)
  assert.match(source, /fileCourseMismatch/)
})
