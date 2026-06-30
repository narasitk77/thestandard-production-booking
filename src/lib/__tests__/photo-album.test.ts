import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isPhotoAlbumBooking, bookingNeedsSound } from '../outlet-folders'

const ep = (code: string | null) => ({ program: code === null ? null : { code } })

test('isPhotoAlbumBooking: all-A episodes → photo album', () => {
  assert.equal(isPhotoAlbumBooking([ep('A')]), true)
  assert.equal(isPhotoAlbumBooking([ep('A'), ep('A')]), true)
  assert.equal(isPhotoAlbumBooking([ep('a')]), true) // case-insensitive
})

test('isPhotoAlbumBooking: video / mixed / empty → not photo', () => {
  assert.equal(isPhotoAlbumBooking([ep('L')]), false)
  assert.equal(isPhotoAlbumBooking([ep('A'), ep('L')]), false) // mixed → video
  assert.equal(isPhotoAlbumBooking([ep(null)]), false)
  assert.equal(isPhotoAlbumBooking([]), false) // no episodes
})

test('bookingNeedsSound: true only when crewRequired has Sound', () => {
  assert.equal(bookingNeedsSound(['Videographer', 'Sound']), true)
  assert.equal(bookingNeedsSound(['Sound']), true)
  assert.equal(bookingNeedsSound(['Videographer', 'Photographer']), false)
  assert.equal(bookingNeedsSound([]), false)
  assert.equal(bookingNeedsSound(null), false)
  assert.equal(bookingNeedsSound(undefined), false)
})
