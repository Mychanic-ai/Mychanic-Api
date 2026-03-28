import { createClient } from '@/lib/supabase-server'
import { createAdminClient } from '@/lib/supabase-admin'
import { NextRequest, NextResponse } from 'next/server'
import crypto from 'crypto'
import { withApiLogger } from '@/lib/withApiLogger'
import { logger } from '@/lib/logger'

const INVITE_EXPIRATION_HOURS = 48

export const POST = withApiLogger(async (request: NextRequest) => {
  try {
    // 1. Authenticate the requesting user
    // Support both cookie-based (web) and Bearer token (mobile) auth
    const adminClientForAuth = createAdminClient()
    let user: any = null
    const authHeader = request.headers.get('authorization')
    if (authHeader?.startsWith('Bearer ')) {
      const token = authHeader.slice(7)
      const { data } = await adminClientForAuth.auth.getUser(token)
      user = data.user
    } else {
      const supabase = await createClient()
      const { data } = await supabase.auth.getUser()
      user = data.user
    }

    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // 2. Parse and validate input
    const body = await request.json()
    const { email, role, shop_id, deviceType } = body

    logger.setContext({ userId: user.id, shopId: shop_id })

    if (!email || !role || !shop_id || !deviceType) {
      return NextResponse.json(
        { error: 'email, role, shop_id, and deviceType are required' },
        { status: 400 }
      )
    }

    if (!['manager', 'technician'].includes(role)) {
      return NextResponse.json(
        { error: 'role must be "manager" or "technician"' },
        { status: 400 }
      )
    }

    if (!['ios', 'android'].includes(deviceType)) {
      return NextResponse.json(
        { error: 'deviceType must be "ios" or "android"' },
        { status: 400 }
      )
    }

    // Basic email format validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    if (!emailRegex.test(email)) {
      return NextResponse.json(
        { error: 'Invalid email format' },
        { status: 400 }
      )
    }

    // 3. Verify the authenticated user can invite to this shop.
    //    Global admins (role = 'admin' in ANY shop, OR owner of any shop) can invite to all shops.
    //    Managers can only invite to shops they are explicitly connected to.
    const adminClient = createAdminClient()

    // Check if caller is a global admin via user_shop_access
    const { data: adminRow } = await adminClient
      .from('user_shop_access')
      .select('role')
      .eq('user_id', user.id)
      .eq('role', 'admin')
      .limit(1)

    // Also check if they own any shop (owner_id = user.id)
    const { data: ownedShop } = await adminClient
      .from('shops')
      .select('id')
      .eq('owner_id', user.id)
      .limit(1)

    const isGlobalAdmin =
      (adminRow && adminRow.length > 0) ||
      (ownedShop && ownedShop.length > 0)

    // For non-admins, verify they are a manager of this specific shop
    let callerRole: string = 'admin'

    if (!isGlobalAdmin) {
      const { data: access, error: accessError } = await adminClient
        .from('user_shop_access')
        .select('role')
        .eq('user_id', user.id)
        .eq('shop_id', shop_id)
        .eq('is_active', true)
        .eq('role', 'manager')
        .maybeSingle()

      if (accessError) {
        logger.error({ event: 'supabase_error', table: 'user_shop_access', operation: 'select', code: accessError.code, message: accessError.message })
        return NextResponse.json(
          { error: 'Failed to verify permissions' },
          { status: 500 }
        )
      }

      if (!access) {
        logger.warn({ event: 'access_denied', userId: user.id, shopId: shop_id, action: 'invite_user', reason: 'not a manager of this shop' })
        return NextResponse.json(
          { error: 'You do not have permission to invite users to this shop' },
          { status: 403 }
        )
      }

      callerRole = access.role
    }

    // 3b. Enforce what roles the caller is allowed to assign.
    //     Managers can only invite technicians.
    //     Admins can invite managers or technicians.
    const allowedInviteRoles: string[] =
      callerRole === 'manager' ? ['technician'] : ['technician', 'manager']

    if (!allowedInviteRoles.includes(role)) {
      logger.warn({ event: 'access_denied', userId: user.id, shopId: shop_id, action: 'invite_user', reason: `role escalation attempt: ${callerRole} tried to invite ${role}` })
      return NextResponse.json(
        {
          error:
            callerRole === 'manager'
              ? 'Managers can only invite technicians'
              : 'Invalid role for this operation',
        },
        { status: 403 }
      )
    }

    // 4. Verify the shop exists and is active
    const { data: shop, error: shopError } = await adminClient
      .from('shops')
      .select('id, name, status')
      .eq('id', shop_id)
      .eq('status', 'active')
      .maybeSingle()

    if (shopError || !shop) {
      return NextResponse.json(
        { error: 'Shop not found or inactive' },
        { status: 404 }
      )
    }

    // 5. Check for existing unused, unexpired invite for same email + shop
    const { data: existingInvite } = await adminClient
      .from('invites')
      .select('id, expires_at')
      .eq('email', email.toLowerCase().trim())
      .eq('shop_id', shop_id)
      .is('used_at', null)
      .gt('expires_at', new Date().toISOString())
      .maybeSingle()

    if (existingInvite) {
      return NextResponse.json(
        { error: 'An active invite already exists for this email and shop' },
        { status: 409 }
      )
    }

    // 6. Check if user already has access to this shop
    // Look up if an auth user with this email already has access
    const { data: existingAuthUser } = await adminClient.auth.admin.listUsers()
    const targetUser = existingAuthUser?.users?.find(
      (u) => u.email?.toLowerCase() === email.toLowerCase().trim()
    )

    if (targetUser) {
      const { data: alreadyHasAccess } = await adminClient
        .from('user_shop_access')
        .select('id')
        .eq('user_id', targetUser.id)
        .eq('shop_id', shop_id)
        .eq('is_active', true)
        .maybeSingle()

      if (alreadyHasAccess) {
        return NextResponse.json(
          { error: 'This user already has access to this shop' },
          { status: 409 }
        )
      }
    }

    // 7. Generate secure token
    const token = crypto.randomBytes(32).toString('hex')

    // 8. Calculate expiration
    const expiresAt = new Date()
    expiresAt.setHours(expiresAt.getHours() + INVITE_EXPIRATION_HOURS)

    // 9. Insert invite record
    const { data: invite, error: insertError } = await adminClient
      .from('invites')
      .insert({
        email: email.toLowerCase().trim(),
        role,
        shop_id,
        token,
        expires_at: expiresAt.toISOString(),
        invited_by: user.id,
      })
      .select('id, email, role, expires_at')
      .single()

    if (insertError) {
      logger.error({ event: 'supabase_error', table: 'invites', operation: 'insert', code: insertError.code, message: insertError.message })
      return NextResponse.json(
        { error: 'Failed to create invite' },
        { status: 500 }
      )
    }

    // 10. Generate invite link and send via Resend
    const appUrl = process.env.NEXT_PUBLIC_SITE_URL || 'https://app.mychanic.com'

    try {
      const resendApiKey = process.env.RESEND_API_KEY
      if (!resendApiKey) {
        logger.error({ event: 'external_service_error', service: 'resend', message: 'RESEND_API_KEY not configured — invite created but email not sent' })
      } else {
        // Generate Supabase web auth link for web users
        const linkType = targetUser ? 'magiclink' : 'invite'
        const { data: linkData, error: linkError } = await adminClient.auth.admin.generateLink({
          type: linkType,
          email: email.toLowerCase().trim(),
          options: { redirectTo: `${appUrl}/auth/callback?next=/invite/setup` },
        })

        let inviteLink = appUrl
        let linkButtonText = 'Get Started'

        if (!linkError && linkData?.properties?.action_link) {
          inviteLink = linkData.properties.action_link
          linkButtonText = targetUser ? 'Accept Invite & Sign In' : 'Accept Invite'
        } else if (linkError) {
          logger.error({ event: 'supabase_error', operation: 'generateLink', message: linkError.message })
        }

        const roleDisplay = role === 'manager' ? 'Manager' : 'Technician'

        // Determine mobile app download link based on device type
        const appDownloadLink = deviceType === 'ios'
          ? 'https://testflight.apple.com/join/pUSSxUr5'
          : 'https://play.google.com/apps/internaltest/4701727609132155249'

        const emailResponse = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${resendApiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            from: process.env.RESEND_FROM_EMAIL || 'Mychanic <invites@mychanic.com>',
            to: [email.toLowerCase().trim()],
            subject: `You've been invited to join ${shop.name} on Mychanic`,
            html: `
              <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:32px 20px;background:#0f0f0f;color:#f5f5f5;">
                <div style="margin-bottom:24px;">
                  <h1 style="font-size:24px;font-weight:700;margin:0;color:#ffffff;">Mychanic</h1>
                </div>
                <div style="background:#1a1a1a;border:1px solid #2a2a2a;border-radius:12px;padding:32px;">
                  <h2 style="font-size:20px;font-weight:600;margin:0 0 12px;color:#ffffff;">You&apos;re Invited!</h2>
                  <p style="font-size:15px;color:#a0a0a0;margin:0 0 24px;">
                    You&apos;ve been invited to join <strong style="color:#ffffff;">${shop.name}</strong>
                    as a <strong style="color:#ffffff;">${roleDisplay}</strong> on Mychanic.
                  </p>
                  <a href="${inviteLink}"
                     style="display:inline-block;background-color:#2563eb;color:#ffffff;padding:14px 28px;
                            text-decoration:none;border-radius:8px;font-size:15px;font-weight:600;">
                    ${linkButtonText}
                  </a>
                  <div style="margin:24px 0 0;padding:20px;background:#0f0f0f;border-radius:8px;border:1px solid #2a2a2a;">
                    <p style="font-size:13px;color:#a0a0a0;margin:0 0 12px;font-weight:600;">Download the Mobile App:</p>
                    <a href="${appDownloadLink}"
                       target="_blank"
                       style="display:inline-block;background-color:#10b981;color:#ffffff;padding:10px 16px;
                              text-decoration:none;border-radius:6px;font-size:13px;font-weight:600;">
                      ${deviceType === 'ios' ? 'Join on TestFlight' : 'Get on Google Play'}
                    </a>
                  </div>
                  <p style="font-size:13px;color:#606060;margin:24px 0 0;">
                    This invitation expires in ${INVITE_EXPIRATION_HOURS} hours.
                    If you didn&apos;t expect this, you can safely ignore it.
                  </p>
                </div>
                <p style="font-size:12px;color:#404040;margin:20px 0 0;text-align:center;">
                  Mychanic &mdash; Auto Shop Management
                </p>
              </div>
            `,
          }),
        });

        if (!emailResponse.ok) {
          const emailError = await emailResponse.text()
          logger.error({ event: 'external_service_error', service: 'resend', message: emailError })
        }
      }
    } catch (emailError) {
      logger.error({ event: 'external_service_error', service: 'resend', message: emailError instanceof Error ? emailError.message : String(emailError) })
      // Don't fail the request — invite record was created successfully
    }

    return NextResponse.json({
      success: true,
      invite: {
        id: invite.id,
        email: invite.email,
        role: invite.role,
        expires_at: invite.expires_at,
      },
    }, { status: 201 })

  } catch (error) {
    logger.error({ event: 'unhandled_exception', message: error instanceof Error ? error.message : String(error) })
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
})
