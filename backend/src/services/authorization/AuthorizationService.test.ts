import { describe, expect, it } from 'vitest';
import { canModifyPTO, canViewNote } from './AuthorizationService.js';

describe('AuthorizationService', () => {
  const member = { id: 'u-member', role: 'member' as const };
  const teamLead = { id: 'u-lead', role: 'team_lead' as const };
  const ownPto = { userId: 'u-member' };
  const otherPto = { userId: 'u-other' };

  describe('canModifyPTO', () => {
    it('lets a member modify their own PTO', () => {
      expect(canModifyPTO(member, ownPto)).toBe(true);
    });

    it('blocks a member from modifying another member PTO', () => {
      expect(canModifyPTO(member, otherPto)).toBe(false);
    });

    it('blocks a member from modifying a team lead PTO', () => {
      const leadPto = { userId: 'u-lead' };
      expect(canModifyPTO(member, leadPto)).toBe(false);
    });

    it('lets a team lead modify their own PTO', () => {
      const ownLeadPto = { userId: 'u-lead' };
      expect(canModifyPTO(teamLead, ownLeadPto)).toBe(true);
    });

    it('lets a team lead modify another member PTO', () => {
      expect(canModifyPTO(teamLead, otherPto)).toBe(true);
    });

    it('lets a team lead modify another team lead PTO', () => {
      const leadPto = { userId: 'u-other' };
      const otherLead = { id: 'u-other', role: 'team_lead' as const };
      expect(canModifyPTO(teamLead, leadPto)).toBe(true);
      expect(canModifyPTO(otherLead, leadPto)).toBe(true);
    });

    it('returns false when actor id is empty string and not a lead', () => {
      const empty = { id: '', role: 'member' as const };
      expect(canModifyPTO(empty, ownPto)).toBe(false);
    });
  });

  describe('canViewNote', () => {
    it('mirrors canModifyPTO for owner', () => {
      expect(canViewNote(member, ownPto)).toBe(canModifyPTO(member, ownPto));
    });

    it('mirrors canModifyPTO for non-owner', () => {
      expect(canViewNote(member, otherPto)).toBe(canModifyPTO(member, otherPto));
    });

    it('mirrors canModifyPTO for team lead', () => {
      expect(canViewNote(teamLead, otherPto)).toBe(canModifyPTO(teamLead, otherPto));
    });
  });
});
