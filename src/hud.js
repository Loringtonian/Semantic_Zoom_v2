// Canvas overlays: level HUD, scrollbar, zoom particles and the hovered-word underline.
import { SB_WIDTH } from './viewport.js'

export function generateLevelNames(count) {
  if (count <= 1) return ['original']
  if (count === 2) return ['overview', 'original']
  if (count === 3) return ['thesis', 'summary', 'original']
  const names = ['thesis']
  const middle = count - 2
  for (let i = 0; i < middle; i++) {
    const ratio = (i + 1) / (middle + 1)
    if (ratio < 0.25) names.push('overview')
    else if (ratio < 0.5) names.push('summary')
    else if (ratio < 0.75) names.push('expanded')
    else names.push('detailed')
  }
  names.push('original')
  const seen = {}
  return names.map(n => { seen[n] = (seen[n] || 0) + 1; return seen[n] > 1 ? `${n}-${seen[n]}` : n })
}

// `s` is {treeData, maxLevel, currentLevel, measuredLevels, hoveredWord, hoveredConcept, trackedConcept}.
export function drawHUD(renderer, s) {
  const ctx = renderer.ctx, dpr = renderer.dpr
  const w = renderer.width, h = renderer.height
  ctx.save(); ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.font = '13px monospace'; ctx.textBaseline = 'bottom'

  const names = s.treeData?.levelNames || generateLevelNames(s.maxLevel + 1)
  ctx.fillStyle = 'rgba(255,255,255,0.35)'
  ctx.fillText(`Level ${s.currentLevel} — ${names[s.currentLevel] || `level-${s.currentLevel}`}`, 16, h - 12)

  const nodes = s.measuredLevels[s.currentLevel]
  if (nodes) {
    const countWords = ns => ns.reduce((sum, n) => sum + n.text.split(/\s+/).length, 0)
    const words = countWords(nodes)
    const full = s.measuredLevels[s.maxLevel]
    const total = full ? countWords(full) : words
    ctx.fillText(`${words} / ${total} words`, 16, h - 30)
  }

  if (s.hoveredWord) { ctx.fillStyle = 'rgba(120,180,255,0.5)'; ctx.fillText(`→ ${s.hoveredWord.word}`, 16, h - 48) }
  // Prefer the live-detected concept, except while tracking through a level
  // where the concept should be visible but its anchor is missing from data.
  const tracked = s.trackedConcept
  const trackedAnchorGap = tracked &&
    !tracked.anchors?.[String(s.currentLevel)] &&
    s.currentLevel >= (tracked.min_visible_level ?? 0)
  const labelConcept = trackedAnchorGap ? tracked : (s.hoveredConcept || tracked)
  if (labelConcept) {
    ctx.fillStyle = s.hoveredConcept ? 'rgba(255,200,100,0.5)' : 'rgba(255,200,100,0.25)'
    ctx.fillText(`◆ ${labelConcept.label}`, 16, h - 66)
  }

  ctx.textAlign = 'right'; ctx.fillStyle = 'rgba(255,255,255,0.2)'
  ctx.fillText('Right click or +: zoom in  |  Left click or -: zoom out  |  Drag/scroll: pan', w - 16, h - 12)
  ctx.restore()
}

export function drawScrollbar(renderer, g, active) {
  if (!g) return
  const ctx = renderer.ctx, dpr = renderer.dpr
  ctx.save(); ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.fillStyle = 'rgba(255,255,255,0.04)'
  ctx.fillRect(g.trackX, g.trackY, SB_WIDTH, g.trackH)
  ctx.fillStyle = active ? 'rgba(150,190,255,0.55)' : 'rgba(255,255,255,0.22)'
  const r = 4
  const x = g.trackX, y = g.thumbY, w = SB_WIDTH, h = g.thumbH
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r)
  ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h)
  ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r)
  ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y)
  ctx.fill()
  ctx.restore()
}

const particles = []

export function spawnZoomIndicator(x, y, dir) {
  particles.push({ x, y: y + (dir > 0 ? -50 : 50), drift: dir > 0 ? -1.8 : 1.8,
    symbol: dir > 0 ? '+ +' : '– –', life: 1.0, decay: 0.018, scale: 1.0 })
}

export function updateAndDrawParticles(renderer) {
  const ctx = renderer.ctx, dpr = renderer.dpr
  ctx.save(); ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i]; p.life -= p.decay; p.y += p.drift; p.scale = 0.85 + 0.3 * p.life
    if (p.life <= 0) { particles.splice(i, 1); continue }
    const a = p.life * p.life, s = 36 * p.scale
    ctx.save(); ctx.globalAlpha = a * 0.25; ctx.font = `800 ${s+8}px system-ui,sans-serif`
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = '#5bf'
    ctx.shadowColor = '#38f'; ctx.shadowBlur = 30; ctx.fillText(p.symbol, p.x, p.y)
    ctx.fillText(p.symbol, p.x, p.y); ctx.restore()
    ctx.save(); ctx.globalAlpha = a * 0.5; ctx.font = `800 ${s+2}px system-ui,sans-serif`
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = '#8cf'
    ctx.shadowColor = '#5af'; ctx.shadowBlur = 14; ctx.fillText(p.symbol, p.x, p.y); ctx.restore()
    ctx.save(); ctx.globalAlpha = a * 0.95; ctx.font = `800 ${s}px system-ui,sans-serif`
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = '#fff'
    ctx.shadowColor = '#6bf'; ctx.shadowBlur = 6; ctx.fillText(p.symbol, p.x, p.y); ctx.restore()
  }
  ctx.restore()
}

export function drawWordHighlight(renderer, hoveredWord) {
  if (!hoveredWord?.screenRect) return
  const ctx = renderer.ctx, dpr = renderer.dpr, r = hoveredWord.screenRect
  ctx.save(); ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.fillStyle = 'rgba(100,170,255,0.12)'; ctx.fillRect(r.x-2, r.y+2, r.w+4, r.h-4)
  ctx.strokeStyle = 'rgba(120,180,255,0.7)'; ctx.lineWidth = 2
  ctx.shadowColor = 'rgba(100,170,255,0.5)'; ctx.shadowBlur = 8
  ctx.beginPath(); ctx.moveTo(r.x, r.y+r.h-5); ctx.lineTo(r.x+r.w, r.y+r.h-5); ctx.stroke()
  ctx.restore()
}
