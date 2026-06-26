/**
 * Role tier model (v1.38) — truth tables for the capability helpers.
 * These gates drive the /admin + /dashboard layouts and the permissions
 * matrix, so a wrong line here locks a whole tier out (see v1.50, where
 * the layouts had drifted from this model and blocked COORDINATOR).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  hasConsoleAccess,
  canApproveOTByRole,
  positionGrantsOT,
  canManageRoles,
  canEditUser,
  assignableRoles,
  canAddUser,
} from '../roles'

test('console access: every staff tier, plain USER excluded', () => {
  assert.equal(hasConsoleAccess('ADMIN'), true)
  assert.equal(hasConsoleAccess('SUPPORT'), true)
  assert.equal(hasConsoleAccess('MANAGER'), true)
  assert.equal(hasConsoleAccess('COORDINATOR'), true)
  assert.equal(hasConsoleAccess('USER'), false)
  assert.equal(hasConsoleAccess(null), false)
  assert.equal(hasConsoleAccess(undefined), false)
})

test('OT approval: Admin + Manager only', () => {
  assert.equal(canApproveOTByRole('ADMIN'), true)
  assert.equal(canApproveOTByRole('MANAGER'), true)
  assert.equal(canApproveOTByRole('SUPPORT'), false)
  assert.equal(canApproveOTByRole('COORDINATOR'), false)
  assert.equal(canApproveOTByRole('USER'), false)
})

test('OT approval by position: production managers yes, Project Manager no', () => {
  assert.equal(positionGrantsOT('Video Production Manager'), true)
  assert.equal(positionGrantsOT('Production Manager'), true)
  assert.equal(positionGrantsOT('Manager'), true)
  // PM office — must NOT approve crew OT
  assert.equal(positionGrantsOT('Project Manager'), false)
  assert.equal(positionGrantsOT('Senior Project Manager'), false)
  assert.equal(positionGrantsOT('project manager'), false)
  // non-managers
  assert.equal(positionGrantsOT('Project Coordinator'), false)
  assert.equal(positionGrantsOT('Videographer'), false)
  assert.equal(positionGrantsOT(''), false)
  assert.equal(positionGrantsOT(null), false)
})

test('role management: Support cannot, Coordinator can (Users only)', () => {
  assert.equal(canManageRoles('ADMIN'), true)
  assert.equal(canManageRoles('MANAGER'), true)
  assert.equal(canManageRoles('COORDINATOR'), true)
  assert.equal(canManageRoles('SUPPORT'), false)
  assert.equal(canManageRoles('USER'), false)
})

test('canEditUser: strictly-below rule with Support protected', () => {
  // ADMIN edits anyone, including SUPPORT
  assert.equal(canEditUser('ADMIN', 'SUPPORT'), true)
  assert.equal(canEditUser('ADMIN', 'ADMIN'), true)
  // MANAGER manages up to Coordinator, never Support/Admin
  assert.equal(canEditUser('MANAGER', 'COORDINATOR'), true)
  assert.equal(canEditUser('MANAGER', 'USER'), true)
  assert.equal(canEditUser('MANAGER', 'SUPPORT'), false)
  assert.equal(canEditUser('MANAGER', 'MANAGER'), false)
  // COORDINATOR manages plain Users only
  assert.equal(canEditUser('COORDINATOR', 'USER'), true)
  assert.equal(canEditUser('COORDINATOR', 'COORDINATOR'), false)
  // SUPPORT/USER manage nobody
  assert.equal(canEditUser('SUPPORT', 'USER'), false)
  assert.equal(canEditUser('USER', 'USER'), false)
})

test('assignableRoles: Manager caps at Coordinator, Coordinator cannot promote', () => {
  assert.deepEqual(assignableRoles('ADMIN'), ['ADMIN', 'SUPPORT', 'MANAGER', 'COORDINATOR', 'USER'])
  assert.deepEqual(assignableRoles('MANAGER'), ['COORDINATOR', 'USER'])
  assert.deepEqual(assignableRoles('COORDINATOR'), ['USER'])
  assert.deepEqual(assignableRoles('SUPPORT'), [])
  assert.deepEqual(assignableRoles('USER'), [])
})

test('canAddUser: Admin/Manager within their assignable set, Coordinator never', () => {
  assert.equal(canAddUser('ADMIN', 'MANAGER'), true)
  assert.equal(canAddUser('MANAGER', 'COORDINATOR'), true)
  assert.equal(canAddUser('MANAGER', 'MANAGER'), false)
  assert.equal(canAddUser('COORDINATOR', 'USER'), false)
  assert.equal(canAddUser('SUPPORT', 'USER'), false)
})
