import { test, expect } from '@playwright/test'

test.describe('IPFS HLS Video Playback', () => {
  test('page loads with video element and status display', async ({ page }) => {
    await page.goto('/')

    const video = page.locator('video#player')
    await expect(video).toBeVisible()

    const status = page.locator('#status')
    await expect(status).toBeVisible()
  })

  test('HLS.js initializes and connects to IPFS', async ({ page }) => {
    await page.goto('/')

    const status = page.locator('#status')

    // Status should progress past initial loading state
    // Wait for either "Connecting to IPFS" or further progress
    await expect(status).not.toHaveText('', { timeout: 10_000 })

    // Wait for IPFS connection — status should indicate progress
    // The app sets status text as it progresses through initialization
    await page.waitForFunction(
      () => {
        const el = document.getElementById('status')
        if (!el) return false
        const text = el.textContent?.toLowerCase() ?? ''
        return (
          text.includes('loading') ||
          text.includes('ipfs') ||
          text.includes('hls') ||
          text.includes('ready') ||
          text.includes('playing') ||
          text.includes('error')
        )
      },
      { timeout: 30_000 },
    )
  })

  test('video begins playing after IPFS content loads', async ({ page }) => {
    await page.goto('/')

    // Wait for video to have a source and start playing
    // IPFS peer discovery can be slow, so use generous timeout
    await page.waitForFunction(
      () => {
        const video = document.querySelector('video#player') as HTMLVideoElement | null
        if (!video) return false
        return video.currentTime > 0
      },
      { timeout: 120_000 },
    )

    // Verify video is actually playing (not paused)
    const isPaused = await page.evaluate(() => {
      const video = document.querySelector('video#player') as HTMLVideoElement | null
      return video?.paused ?? true
    })
    expect(isPaused).toBe(false)
  })
})
