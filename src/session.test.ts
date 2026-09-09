import { describe, expect, it } from 'vitest'

import { isSignedInUrl } from './session'

describe('isSignedInUrl', () => {
  it('accepts the signed-in library and reader', () => {
    expect(isSignedInUrl('https://read.amazon.com/kindle-library')).toBe(true)
    expect(isSignedInUrl('https://read.amazon.com/?asin=B01H4G2J1U')).toBe(true)
    expect(isSignedInUrl('https://read.amazon.com/')).toBe(true)
  })

  it('rejects Amazon sign-in pages, wherever they live', () => {
    expect(
      isSignedInUrl('https://www.amazon.com/ap/signin?openid.pape=x')
    ).toBe(false)
    // An expired session can bounce to a signin path on the reader host too.
    expect(isSignedInUrl('https://read.amazon.com/ap/signin')).toBe(false)
    expect(isSignedInUrl('https://read.amazon.com/gp/signin')).toBe(false)
  })

  it('rejects everything that is not the reader host over https', () => {
    // A hostname that merely starts with the reader's must not pass — this is
    // what a substring check would get wrong.
    expect(isSignedInUrl('https://read.amazon.com.evil.example/')).toBe(false)
    expect(isSignedInUrl('http://read.amazon.com/kindle-library')).toBe(false)
    expect(isSignedInUrl('https://www.amazon.com/')).toBe(false)
    expect(isSignedInUrl('about:blank')).toBe(false)
    expect(isSignedInUrl('')).toBe(false)
    expect(isSignedInUrl('not a url')).toBe(false)
  })

  it('ignores signin-looking strings in the query, not the path', () => {
    expect(
      isSignedInUrl('https://read.amazon.com/kindle-library?from=/ap/signin')
    ).toBe(true)
  })
})
