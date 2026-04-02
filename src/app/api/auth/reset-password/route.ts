import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase-admin'
import { withApiLogger } from '@/lib/withApiLogger'
import { logger } from '@/lib/logger'

/**
 * POST /api/auth/reset-password
 * Sends a custom branded password reset email via Resend
 */
export const POST = withApiLogger(async (request: NextRequest) => {
  try {
    const { email } = await request.json()

    if (!email) {
      return NextResponse.json(
        { error: 'Email is required' },
        { status: 400 }
      )
    }

    const admin = createAdminClient()
    const resendApiKey = process.env.RESEND_API_KEY

    if (!resendApiKey) {
      logger.error({ event: 'external_service_error', service: 'resend', message: 'RESEND_API_KEY not configured' })
      return NextResponse.json(
        { success: true, message: 'If the email exists, a password reset link has been sent' },
        { status: 200 }
      )
    }

    try {
      // Use the site URL so the /api/ path is proxied through the site to this server.
      // This URL must be in the Supabase project's allowed redirect URLs list.
      const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || 'https://www.mychanic.ai'

      // Generate recovery link using Supabase admin API
      const { data: linkData, error: linkError } = await admin.auth.admin.generateLink({
        type: 'recovery',
        email: email.toLowerCase().trim(),
        options: {
          redirectTo: `${siteUrl}/api/auth/reset-password-callback`,
        },
      })

      let resetLink = `${siteUrl}/api/auth/reset-password-callback`
      
      if (!linkError && linkData?.properties?.action_link) {
        resetLink = linkData.properties.action_link
      } else if (linkError) {
        logger.error({ event: 'supabase_error', operation: 'generateLink', message: linkError.message })
      }

      const emailResponse = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${resendApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: process.env.RESEND_FROM_EMAIL || 'Mychanic <noreply@mychanic.ai>',
          to: [email.toLowerCase().trim()],
          subject: 'Reset Your Mychanic Password',
          html: `
            <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:32px 20px;background:#0f0f0f;color:#f5f5f5;">
              <div style="margin-bottom:24px;">
                <h1 style="font-size:24px;font-weight:700;margin:0;color:#ffffff;">Mychanic</h1>
              </div>
              <div style="background:#1a1a1a;border:1px solid #2a2a2a;border-radius:12px;padding:32px;">
                <h2 style="font-size:20px;font-weight:600;margin:0 0 12px;color:#ffffff;">Reset Your Password</h2>
                <p style="font-size:15px;color:#a0a0a0;margin:0 0 24px;">
                  We received a request to reset your password. Click the button below to create a new password.
                </p>
                <a href="${resetLink}"
                   style="display:inline-block;background-color:#2563eb;color:#ffffff;padding:14px 28px;
                          text-decoration:none;border-radius:8px;font-size:15px;font-weight:600;">
                  Reset Password
                </a>
                <p style="font-size:13px;color:#606060;margin:24px 0 0;">
                  This link expires in 24 hours. If you didn't request a password reset, you can safely ignore this email.
                </p>
                <p style="font-size:13px;color:#606060;margin:12px 0 0;">
                  If the button above doesn't work, try pasting this link in your browser:
                  <br />
                  <span style="font-family:monospace;color:#808080;word-break:break-all;">${resetLink}</span>
                </p>
              </div>
              <p style="font-size:12px;color:#404040;margin:20px 0 0;text-align:center;">
                Mychanic &mdash; Auto Shop Management
              </p>
            </div>
          `,
        }),
      })

      const emailResult = await emailResponse.json()

      if (!emailResponse.ok) {
        logger.error({ event: 'external_service_error', service: 'resend', status: emailResponse.status, message: emailResponse.statusText })
      }
    } catch (emailError) {
      logger.error({ event: 'external_service_error', service: 'resend', message: emailError instanceof Error ? emailError.message : String(emailError) })
      // Don't fail the request — still return success for security
    }

    logger.info({ event: 'password_reset_requested', email: email.toLowerCase().trim() })

    return NextResponse.json(
      { success: true, message: 'If the email exists, a password reset link has been sent' },
      { status: 200 }
    )
  } catch (error) {
    logger.error({ event: 'unhandled_exception', message: error instanceof Error ? error.message : String(error) })
    return NextResponse.json(
      { error: 'An error occurred while processing your request' },
      { status: 500 }
    )
  }
})
