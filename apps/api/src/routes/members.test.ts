import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTestApp, uniqueSlug } from "../test-helpers";

describe("team members and invitations", () => {
  let t: Awaited<ReturnType<typeof buildTestApp>>;

  beforeAll(async () => {
    t = await buildTestApp();
  });

  afterAll(async () => {
    await t.close();
  });

  async function ownerWithOrg() {
    const owner = await t.signIn();
    const res = await t.app.inject({
      method: "POST",
      url: "/orgs",
      headers: owner.headers,
      payload: { name: "Test High School", slug: uniqueSlug("ths"), type: "SCHOOL" },
    });
    return { owner, orgId: res.json<{ organization: { id: string } }>().organization.id };
  }

  function invite(headers: Record<string, string>, orgId: string, email: string, role: string) {
    return t.app.inject({
      method: "POST",
      url: `/orgs/${orgId}/invitations`,
      headers,
      payload: { email, role },
    });
  }

  function inviteToken(email: string) {
    const mail = t.sent.findLast((m) => m.to === email);
    return new URL(mail!.text.match(/https:\S+/)![0]).searchParams.get("token")!;
  }

  const newEmail = () => `invitee-${randomUUID()}@example.com`;

  it("invites someone who accepts, joins with that role and is signed in", async () => {
    const { owner, orgId } = await ownerWithOrg();
    const email = newEmail();
    const res = await invite(owner.headers, orgId, email.toUpperCase(), "DOOR_STAFF");
    expect(res.statusCode).toBe(201);
    expect(res.json().invitation).toMatchObject({ email, role: "DOOR_STAFF" });

    const mail = t.sent.findLast((m) => m.to === email)!;
    expect(mail.subject).toContain("Test High School");
    expect(mail.text).toContain("https://dashboard.test/invite?token=");
    const token = inviteToken(email);

    const lookup = await t.app.inject({
      method: "POST",
      url: "/invitations/lookup",
      payload: { token },
    });
    expect(lookup.json()).toMatchObject({
      email,
      role: "DOOR_STAFF",
      organization: "Test High School",
      invitedBy: "Test Staff",
      hasAccount: false,
    });

    const accept = await t.app.inject({
      method: "POST",
      url: "/invitations/accept",
      payload: { token, name: "Dana Door" },
    });
    expect(accept.statusCode).toBe(200);
    const { sessionToken, organizationId, user } = accept.json();
    expect(organizationId).toBe(orgId);
    expect(user).toMatchObject({ email, name: "Dana Door" });

    const me = await t.app.inject({
      method: "GET",
      url: "/me",
      headers: { authorization: `Bearer ${sessionToken}` },
    });
    expect(me.json().memberships).toEqual([
      expect.objectContaining({
        role: "DOOR_STAFF",
        organization: expect.objectContaining({ id: orgId }),
      }),
    ]);

    const again = await t.app.inject({
      method: "POST",
      url: "/invitations/accept",
      payload: { token },
    });
    expect(again.statusCode).toBe(400);
  });

  it("lists members for everyone but pending invitations only for managers", async () => {
    const { owner, orgId } = await ownerWithOrg();
    const viewerEmail = newEmail();
    await invite(owner.headers, orgId, viewerEmail, "VIEWER");
    const accepted = await t.app.inject({
      method: "POST",
      url: "/invitations/accept",
      payload: { token: inviteToken(viewerEmail) },
    });
    const viewerHeaders = { authorization: `Bearer ${accepted.json().sessionToken}` };
    const pendingEmail = newEmail();
    await invite(owner.headers, orgId, pendingEmail, "ADMIN");

    const asOwner = await t.app.inject({
      method: "GET",
      url: `/orgs/${orgId}/members`,
      headers: owner.headers,
    });
    expect(asOwner.json().members.map((m: { role: string }) => m.role)).toEqual([
      "OWNER",
      "VIEWER",
    ]);
    expect(asOwner.json().invitations).toEqual([
      expect.objectContaining({ email: pendingEmail, role: "ADMIN" }),
    ]);

    const asViewer = await t.app.inject({
      method: "GET",
      url: `/orgs/${orgId}/members`,
      headers: viewerHeaders,
    });
    expect(asViewer.json().members).toHaveLength(2);
    expect(asViewer.json().invitations).toEqual([]);

    const viewerInvites = await invite(viewerHeaders, orgId, newEmail(), "VIEWER");
    expect(viewerInvites.statusCode).toBe(403);
  });

  it("keeps outsiders out", async () => {
    const { orgId } = await ownerWithOrg();
    const stranger = await t.signIn();
    const res = await t.app.inject({
      method: "GET",
      url: `/orgs/${orgId}/members`,
      headers: stranger.headers,
    });
    expect(res.statusCode).toBe(404);
  });

  it("lets only owners invite owners", async () => {
    const { owner, orgId } = await ownerWithOrg();
    const adminEmail = newEmail();
    await invite(owner.headers, orgId, adminEmail, "ADMIN");
    const accepted = await t.app.inject({
      method: "POST",
      url: "/invitations/accept",
      payload: { token: inviteToken(adminEmail) },
    });
    const adminHeaders = { authorization: `Bearer ${accepted.json().sessionToken}` };

    expect((await invite(adminHeaders, orgId, newEmail(), "OWNER")).statusCode).toBe(403);
    expect((await invite(adminHeaders, orgId, newEmail(), "DOOR_STAFF")).statusCode).toBe(201);
    expect((await invite(owner.headers, orgId, newEmail(), "OWNER")).statusCode).toBe(201);
  });

  it("refuses to invite someone already on the team", async () => {
    const { owner, orgId } = await ownerWithOrg();
    const me = await t.app.inject({ method: "GET", url: "/me", headers: owner.headers });
    const res = await invite(owner.headers, orgId, me.json().user.email, "ADMIN");
    expect(res.statusCode).toBe(409);
  });

  it("replaces an earlier invitation when someone is invited again", async () => {
    const { owner, orgId } = await ownerWithOrg();
    const email = newEmail();
    await invite(owner.headers, orgId, email, "VIEWER");
    const first = inviteToken(email);
    await invite(owner.headers, orgId, email, "ADMIN");
    const second = inviteToken(email);

    const stale = await t.app.inject({
      method: "POST",
      url: "/invitations/accept",
      payload: { token: first },
    });
    expect(stale.statusCode).toBe(400);
    const res = await t.app.inject({
      method: "POST",
      url: "/invitations/accept",
      payload: { token: second },
    });
    const me = await t.app.inject({
      method: "GET",
      url: "/me",
      headers: { authorization: `Bearer ${res.json().sessionToken}` },
    });
    expect(me.json().memberships[0].role).toBe("ADMIN");
  });

  it("leaves only one usable link when the same person is invited twice at once", async () => {
    const { owner, orgId } = await ownerWithOrg();
    const email = newEmail();
    const results = await Promise.all([
      invite(owner.headers, orgId, email, "ADMIN"),
      invite(owner.headers, orgId, email, "VIEWER"),
    ]);
    expect(results.map((r) => r.statusCode)).toEqual([201, 201]);
    const open = await t.prisma.invitation.count({
      where: { organizationId: orgId, email, acceptedAt: null, revokedAt: null },
    });
    expect(open).toBe(1);
  });

  it("limits how often one address can be invited", async () => {
    const { owner, orgId } = await ownerWithOrg();
    const email = newEmail();
    for (let i = 0; i < 3; i++) {
      expect((await invite(owner.headers, orgId, email, "VIEWER")).statusCode).toBe(201);
    }
    const res = await invite(owner.headers, orgId, email, "VIEWER");
    expect(res.statusCode).toBe(429);
    expect(res.json().error).toContain("invited several times recently");
  });

  it("holds the address limit when invites arrive at the same moment", async () => {
    const { owner, orgId } = await ownerWithOrg();
    const other = await ownerWithOrg();
    const email = newEmail();
    await invite(owner.headers, orgId, email, "VIEWER");
    await invite(owner.headers, orgId, email, "VIEWER");
    const results = await Promise.all([
      invite(owner.headers, orgId, email, "VIEWER"),
      invite(other.owner.headers, other.orgId, email, "VIEWER"),
    ]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 429]);
  });

  it("limits how many invitations one person sends", async () => {
    const { owner, orgId } = await ownerWithOrg();
    for (let i = 0; i < 30; i++) {
      expect((await invite(owner.headers, orgId, newEmail(), "VIEWER")).statusCode).toBe(201);
    }
    const res = await invite(owner.headers, orgId, newEmail(), "VIEWER");
    expect(res.statusCode).toBe(429);
  });

  it("holds the sender limit when invites arrive at the same moment", async () => {
    const { owner, orgId } = await ownerWithOrg();
    for (let i = 0; i < 29; i++) await invite(owner.headers, orgId, newEmail(), "VIEWER");
    const results = await Promise.all([
      invite(owner.headers, orgId, newEmail(), "VIEWER"),
      invite(owner.headers, orgId, newEmail(), "VIEWER"),
    ]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 429]);
  });

  it("doesn't deadlock when a re-invite races an acceptance", async () => {
    const { owner, orgId } = await ownerWithOrg();
    const email = newEmail();
    await invite(owner.headers, orgId, email, "VIEWER");
    const token = inviteToken(email);
    const [accepted, reinvited] = await Promise.all([
      t.app.inject({ method: "POST", url: "/invitations/accept", payload: { token } }),
      invite(owner.headers, orgId, email, "ADMIN"),
    ]);
    expect([200, 400]).toContain(accepted.statusCode);
    expect([201, 409]).toContain(reinvited.statusCode);
  });

  it("refuses an expired invitation without joining or signing in", async () => {
    const { owner, orgId } = await ownerWithOrg();
    const email = newEmail();
    const created = await invite(owner.headers, orgId, email, "ADMIN");
    const { id } = created.json().invitation;
    await t.prisma.invitation.update({
      where: { id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const token = inviteToken(email);

    const lookup = await t.app.inject({
      method: "POST",
      url: "/invitations/lookup",
      payload: { token },
    });
    expect(lookup.statusCode).toBe(400);
    const accept = await t.app.inject({
      method: "POST",
      url: "/invitations/accept",
      payload: { token },
    });
    expect(accept.statusCode).toBe(400);

    const row = await t.prisma.invitation.findUniqueOrThrow({ where: { id } });
    expect(row.acceptedAt).toBeNull();
    expect(await t.prisma.user.findUnique({ where: { email } })).toBeNull();
  });

  it("revokes a pending invitation", async () => {
    const { owner, orgId } = await ownerWithOrg();
    const email = newEmail();
    const created = await invite(owner.headers, orgId, email, "VIEWER");
    const { id } = created.json().invitation;

    const del = await t.app.inject({
      method: "DELETE",
      url: `/orgs/${orgId}/invitations/${id}`,
      headers: owner.headers,
    });
    expect(del.statusCode).toBe(204);
    const accept = await t.app.inject({
      method: "POST",
      url: "/invitations/accept",
      payload: { token: inviteToken(email) },
    });
    expect(accept.statusCode).toBe(400);

    const other = await ownerWithOrg();
    const crossOrg = await t.app.inject({
      method: "DELETE",
      url: `/orgs/${other.orgId}/invitations/${id}`,
      headers: other.owner.headers,
    });
    expect(crossOrg.statusCode).toBe(404);
  });

  it("keeps an existing member's role when they accept an old invitation", async () => {
    const { owner, orgId } = await ownerWithOrg();
    const email = newEmail();
    await invite(owner.headers, orgId, email, "ADMIN");
    const token = inviteToken(email);
    // They sign in on their own and the owner adds them some other way before they accept.
    const member = await t.signIn(email);
    await t.prisma.membership.create({
      data: { userId: member.userId, organizationId: orgId, role: "VIEWER" },
    });

    const res = await t.app.inject({
      method: "POST",
      url: "/invitations/accept",
      payload: { token },
    });
    expect(res.statusCode).toBe(200);
    const m = await t.prisma.membership.findUniqueOrThrow({
      where: { userId_organizationId: { userId: member.userId, organizationId: orgId } },
    });
    expect(m.role).toBe("VIEWER");
  });
});

describe("when an invitation email is refused", () => {
  it("says so clearly and leaves no invitation behind", async () => {
    const t = await buildTestApp({
      mailer: {
        send: async () => {
          throw new Error("403 You can only send testing emails to your own email address");
        },
      },
    });
    try {
      // Sign-in mail fails too, so seed an owner directly.
      const user = await t.prisma.user.create({
        data: { email: `owner-${randomUUID()}@example.com`, name: "O" },
      });
      const org = await t.prisma.organization.create({
        data: {
          name: "Refused",
          slug: uniqueSlug("refused"),
          type: "SCHOOL",
          memberships: { create: { userId: user.id, role: "OWNER" } },
        },
      });
      const { generateToken, hashToken } = await import("../lib/tokens");
      const token = generateToken();
      await t.prisma.session.create({
        data: {
          userId: user.id,
          tokenHash: hashToken(token),
          expiresAt: new Date(Date.now() + 60_000),
        },
      });
      const email = `someone-${randomUUID()}@example.com`;
      const res = await t.app.inject({
        method: "POST",
        url: `/orgs/${org.id}/invitations`,
        headers: { authorization: `Bearer ${token}` },
        payload: { email, role: "VIEWER" },
      });
      expect(res.statusCode).toBe(502);
      expect(res.json().error).toBe(
        `We couldn't send an email to ${email}. Check the address and try again.`,
      );
      expect(await t.prisma.invitation.count({ where: { email } })).toBe(0);

      const signIn = await t.app.inject({
        method: "POST",
        url: "/auth/magic-link",
        payload: { email },
      });
      expect(signIn.statusCode).toBe(502);
      expect(await t.prisma.magicLinkToken.count({ where: { email } })).toBe(0);
    } finally {
      await t.close();
    }
  });
});
