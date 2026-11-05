import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SOCIAL_PLATFORMS, isSocialPlatform, normalizeSocial, socialUrl } from './social.ts'

test('plain names and @names are accepted', () => {
  assert.equal(normalizeSocial('instagram', 'john.doe'), 'john.doe')
  assert.equal(normalizeSocial('threads', '@john_doe'), 'john_doe')
  assert.equal(normalizeSocial('x', '  jack  '), 'jack')
  assert.equal(normalizeSocial('line', 'my-line.id'), 'my-line.id')
})

test('profile URLs on the right domain yield the account name', () => {
  assert.equal(normalizeSocial('instagram', 'https://www.instagram.com/john.doe/?hl=zh-tw'), 'john.doe')
  assert.equal(normalizeSocial('instagram', 'instagram.com/john.doe'), 'john.doe')
  assert.equal(normalizeSocial('threads', 'https://www.threads.net/@alice'), 'alice')
  assert.equal(normalizeSocial('threads', 'https://threads.com/@alice'), 'alice')
  assert.equal(normalizeSocial('x', 'https://twitter.com/jack'), 'jack')
  assert.equal(normalizeSocial('youtube', 'https://m.youtube.com/@mychannel'), 'mychannel')
  assert.equal(normalizeSocial('tiktok', 'https://www.tiktok.com/@dancer99'), 'dancer99')
  assert.equal(normalizeSocial('telegram', 'https://t.me/some_user'), 'some_user')
  assert.equal(normalizeSocial('line', 'https://line.me/ti/p/~myid123'), 'myid123')
})

test('other domains, look-alike domains and credential tricks are rejected', () => {
  assert.equal(normalizeSocial('instagram', 'https://evil.com/john'), null)
  assert.equal(normalizeSocial('instagram', 'https://instagram.com.evil.com/john'), null)
  assert.equal(normalizeSocial('instagram', 'https://evil.com/instagram.com/john'), null)
  assert.equal(normalizeSocial('instagram', 'https://instagram.com@evil.com/john'), null)
  assert.equal(normalizeSocial('instagram', 'https://user:pw@instagram.com/john'), null)
  assert.equal(normalizeSocial('x', 'https://instagram.com/john'), null, 'a URL for a different platform is not accepted')
})

test('dangerous schemes never get through', () => {
  for (const bad of ['javascript:alert(1)', 'data:text/html,<script>1</script>', 'file:///etc/passwd', 'ftp://instagram.com/x', '//evil.com/x', 'vbscript:x']) {
    for (const p of SOCIAL_PLATFORMS) assert.equal(normalizeSocial(p, bad), null, `${p} <- ${bad}`)
  }
})

test('group invites and non-profile paths are not accepted', () => {
  assert.equal(normalizeSocial('line', 'https://line.me/ti/g/AbCdEfGh12'), null, 'LINE group invite')
  assert.equal(normalizeSocial('line', 'https://line.me/R/ti/p/@someoa'), null)
  assert.equal(normalizeSocial('telegram', 'https://t.me/+AbCdEf123456'), null, 'Telegram private invite')
  assert.equal(normalizeSocial('telegram', 'https://t.me/joinchat/AbCdEf123456'), null, 'two path segments')
  assert.equal(normalizeSocial('instagram', 'https://instagram.com/p/AbC123/'), null, 'a post, not a profile')
  assert.equal(normalizeSocial('youtube', 'https://youtube.com/watch?v=abc'), null)
  assert.equal(normalizeSocial('tiktok', 'https://tiktok.com/video/123'), null)
})

test('malformed names are rejected', () => {
  assert.equal(normalizeSocial('instagram', ''), null)
  assert.equal(normalizeSocial('instagram', '   '), null)
  assert.equal(normalizeSocial('instagram', 'has space'), null)
  assert.equal(normalizeSocial('instagram', 'a'.repeat(31)), null)
  assert.equal(normalizeSocial('x', 'a'.repeat(16)), null)
  assert.equal(normalizeSocial('telegram', 'abcd'), null, 'too short for Telegram')
  assert.equal(normalizeSocial('instagram', '<script>'), null)
  assert.equal(normalizeSocial('instagram', '../admin'), null)
  assert.equal(normalizeSocial('instagram', 42), null)
  assert.equal(normalizeSocial('instagram', 'x'.repeat(500)), null)
})

test('built addresses always use the fixed https domain for the platform', () => {
  assert.equal(socialUrl('instagram', 'john.doe'), 'https://www.instagram.com/john.doe/')
  assert.equal(socialUrl('threads', 'alice'), 'https://www.threads.com/@alice')
  assert.equal(socialUrl('x', 'jack'), 'https://x.com/jack')
  assert.equal(socialUrl('line', 'myid123'), 'https://line.me/ti/p/~myid123')
  // Whatever a user types, a validated name can only ever produce an address on the platform's domain.
  const probes = ['john', 'a.b', '@x_y', 'https://www.instagram.com/probe/']
  for (const p of SOCIAL_PLATFORMS) {
    for (const input of probes) {
      const h = normalizeSocial(p, input)
      if (h) assert.match(new URL(socialUrl(p, h)).hostname, /(^|\.)(threads\.com|instagram\.com|x\.com|facebook\.com|youtube\.com|tiktok\.com|t\.me|line\.me)$/)
    }
  }
})

test('platform ids are validated', () => {
  assert.equal(isSocialPlatform('instagram'), true)
  assert.equal(isSocialPlatform('myspace'), false)
  assert.equal(isSocialPlatform('__proto__'), false)
  assert.equal(isSocialPlatform('constructor'), false)
  assert.equal(isSocialPlatform(undefined), false)
})
