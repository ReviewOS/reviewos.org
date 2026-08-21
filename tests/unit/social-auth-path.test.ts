import { describe, expect, test } from 'bun:test'
import { providerNameFromAuthPath } from '../../app/Actions/Auth/socialPath'

describe('social auth route paths', () => {
  test('reads the provider through the API mount prefix', () => {
    expect(providerNameFromAuthPath('/api/auth/apple')).toBe('apple')
    expect(providerNameFromAuthPath('/api/auth/google/')).toBe('google')
  })

  test('also accepts the unprefixed framework route shape', () => {
    expect(providerNameFromAuthPath('/auth/github')).toBe('github')
  })

  test('reads the same provider on a callback path', () => {
    expect(providerNameFromAuthPath('/api/auth/apple/callback')).toBe('apple')
  })
})
