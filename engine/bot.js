#!/usr/bin/env node
const mineflayer = require('mineflayer')
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')
const toolPlugin = require('mineflayer-tool').plugin
const collectPlugin = require('mineflayer-collectblock').plugin
const readline = require('readline')
const crypto = require('crypto')
const dns = require('dns')
const net = require('net')

for (const m of ['log', 'info', 'debug', 'warn']) {
  console[m] = (...a) => process.stderr.write('[out] ' + a.join(' ') + '\n')
}
console.error = (...a) => process.stderr.write(a.join(' ') + '\n')

function send (o) {
  try { process.stdout.write(JSON.stringify(o) + '\n') } catch (e) {}
}

let chatFilter = true // console hides chat until the TUI toggles it off
let lastCmdAt = 0 // ts of last '/' command sent; system_chat replies near it get logged
let pktlogUntil = 0 // window where inbound packet names get logged (armed by lclick)
let silentMoveUntil = 0 // A/B test: drop outbound movement packets until this ts
let corrStamps = [] // recent correction timestamps for storm detection
let stormStart = 0 // when storm pattern first seen this punch
let silentUsed = false // one auto-silence per punch
let echoExactUntil = 0 // rewrite outbound position to server tp target until this ts
let lastTp = null // last server teleport target {x,y,z}
let outPosN = 0 // outbound position packets seen this punch
let dropN = 0 // movement packets dropped by silent-move test
let defyUntil = 0 // ignore inbound server position snaps until this ts
let defySnapN = 0 // inbound position packets skipped while defying
let beatUntil = 0 // send 20Hz position heartbeat until this ts
let ogForceN = 0 // outbound movement packets whose og=false got forced true
let digFailN = 0 // taskMine dig exceptions logged
const digWatch = new Map() // "x,y,z" -> ts of active bot.dig awaiting removal

function toDER (pem) {
  return pem.split('\n').slice(1, -1).reduce((acc, cur) => Buffer.concat([acc, Buffer.from(cur, 'base64')]), Buffer.alloc(0))
}

function buildProfileKeys (cert) {
  const keys = {
    publicPEM: cert.keyPair.publicKey,
    privatePEM: cert.keyPair.privateKey,
    publicDER: toDER(cert.keyPair.publicKey),
    privateDER: toDER(cert.keyPair.privateKey),
    signature: Buffer.from(cert.publicKeySignature, 'base64'),
    signatureV2: Buffer.from(cert.publicKeySignatureV2, 'base64'),
    expiresOn: new Date(cert.expiresAt),
    refreshAfter: new Date(cert.refreshedAfter)
  }
  keys.public = crypto.createPublicKey({ key: keys.publicDER, format: 'der', type: 'spki' })
  keys.private = crypto.createPrivateKey({ key: keys.privateDER, format: 'der', type: 'pkcs8' })
  return keys
}

function tokenAuth (token, profile) {
  return async (client, options) => {
    try {
      options.haveCredentials = true
      options.accessToken = token
      const undashed = profile.uuid.replace(/-/g, '')
      const session = {
        accessToken: token,
        selectedProfile: { id: undashed, name: profile.name },
        availableProfiles: [{ id: undashed, name: profile.name }]
      }
      client.session = session
      client.username = profile.name

      try {
        const r = await fetch('https://api.minecraftservices.com/player/certificates', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + token, 'User-Agent': 'Minecraft/1.20.6' }
        })
        if (r.ok) {
          const cert = await r.json()
          client.profileKeys = buildProfileKeys(cert)
          send({ evt: 'log', msg: 'chat signing certs ok' })
        } else {
          send({ evt: 'log', msg: 'certs http ' + r.status + ' (joining unsigned)' })
        }
      } catch (e) {
        send({ evt: 'log', msg: 'certs failed: ' + e.message })
      }

      client.emit('session', session)
      options.connect(client)
    } catch (e) {
      send({ evt: 'status', state: 'error', detail: 'auth: ' + e.message })
    }
  }
}

let bot = null
let task = null
let idleTimer = null

const rnd = (a, b) => a + Math.random() * (b - a)
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const cancelled = () => task === null || task.cancelled

function wrapAngle (a) {
  while (a > Math.PI) a -= Math.PI * 2
  while (a < -Math.PI) a += Math.PI * 2
  return a
}

function humanizeLook (b) {
  const origLook = b.look.bind(b)
  const origLookAt = b.lookAt.bind(b)

  b.look = async (yaw, pitch, force) => {
    const jy = rnd(-0.012, 0.012)
    const jp = rnd(-0.01, 0.01)
    const p = b.physics
    const speeds = [
      [3.5, 3.0], [5.5, 4.5], [7.5, 6.0], [10.0, 8.0], [14.0, 11.0]
    ]
    const s = speeds[Math.floor(Math.random() * speeds.length)]
    p.yawSpeed = s[0] * rnd(0.85, 1.2)
    p.pitchSpeed = s[1] * rnd(0.85, 1.2)
    return origLook(wrapAngle(yaw + jy), Math.max(-1.55, Math.min(1.55, pitch + jp)), false)
  }

  b.lookAt = async (point, force) => {
    const pos = point.position ? point.position.offset(0, point.height ? point.height * 0.9 : 1.6, 0) : point
    const delta = pos.minus(b.entity.position.offset(0, b.entity.eyeHeight, 0))
    const yaw = Math.atan2(-delta.x, -delta.z)
    const pitch = Math.atan2(delta.y, Math.hypot(delta.x, delta.z))
    if (Math.random() < 0.18) {
      const over = rnd(0.06, 0.16) * (Math.random() < 0.5 ? 1 : -1)
      await origLook(wrapAngle(yaw + over), pitch, false)
      await sleep(rnd(60, 140))
    }
    return b.look(yaw, pitch, false)
  }
}

function startIdleBehavior (b) {
  const loop = async () => {
    while (!b.entity || !b.entity.position) await sleep(500)
    while (true) {
      await sleep(rnd(2500, 8000))
      if (!bot || bot !== b) return
      if (b.controlState.forward && !b._moving) {
        b.setControlState('forward', false)
        await sleep(rnd(200, 700))
        b.setControlState('forward', true)
      }
      if (Math.random() < 0.55) {
        // mostly small glances, occasional proper look-around
        const amp = Math.random() < 0.15 ? rnd(0.7, 1.1) : rnd(0.1, 0.35)
        const yaw = b.entity.yaw + amp * (Math.random() < 0.5 ? 1 : -1)
        const pitch = b.entity.pitch + rnd(-0.15, 0.15)
        try { await b.look(yaw, pitch, false) } catch (e) {}
      }
    }
  }
  loop().catch(() => {})
}

function makeMovements (b) {
  const m = new Movements(b)
  m.canDig = true
  m.allowSprinting = true
  m.allow1by1towers = false
  m.slowDrops = false
  return m
}

function wire (b) {
  b.loadPlugin(pathfinder)
  b.loadPlugin(toolPlugin)
  b.loadPlugin(collectPlugin)

  b.on('spawn', () => {
    send({ evt: 'status', state: 'online', detail: b.username })
    b.pathfinder.setMovements(makeMovements(b))
    humanizeLook(b)
    startIdleBehavior(b)
    if (!b._defyWrapped) {
      b._defyWrapped = true
      const pre = b._client.listeners('position').filter(fn => fn !== onPositionCorr)
      for (const fn of pre) {
        b._client.removeListener('position', fn)
        b._client.on('position', (packet) => {
          if (Date.now() < defyUntil) {
            defySnapN++
            if (defySnapN === 1 || defySnapN % 20 === 0) {
              send({ evt: 'log', msg: 'DEFY skipped snap#' + defySnapN + ' tid=' + packet.teleportId + ' (confirm only)' })
            }
            try { b._client.write('teleport_confirm', { teleportId: packet.teleportId }) } catch (e) {}
            return
          }
          fn(packet)
        })
      }
      send({ evt: 'log', msg: 'defy wrap: ' + pre.length + ' pre-existing position listener(s) wrapped (ours excluded)' })
    }
  })

  b.on('kicked', (reason) => {
    const text = typeof reason === 'string' ? reason : JSON.stringify(reason)
    const auth = /auth|session|token|verify/i.test(text)
    send({ evt: 'status', state: auth ? 'token_dead' : 'kicked', detail: text })
  })

  b.on('end', (reason) => {
    stopTask()
    send({ evt: 'status', state: 'offline', detail: String(reason || 'closed') })
  })

  b.on('error', (err) => {
    const msg = String(err && err.message || err)
    if (/401|403|access token|failed to join|authenticate/i.test(msg)) {
      send({ evt: 'status', state: 'token_dead', detail: msg })
    } else {
      send({ evt: 'log', msg: 'error: ' + msg })
    }
  })

  // a real player's hands go quiet when they take a hit - let knockback and
  // gravity play out in vanilla physics instead of steering through it
  // (steering mid-air is exactly what Grim's velocity/simulation flags catch)
  // hold long enough for a full hop to land (~1s) so we never re-path airborne
  let lastHp = null
  b.on('health', () => {
    const hp = b.health
    if (lastHp != null && hp < lastHp - 0.01) {
      b._holdUntil = Date.now() + rnd(900, 1400)
      b._needReissue = true
      try { b.pathfinder.stop() } catch (e) {}
    }
    lastHp = hp
  })

  // grim rubberband = server sent a position correction. stop driving, let the
  // corrected position stand, then re-path - fighting it every tick is what
  // keeps the freeze loop alive (once client==server again, motion resumes)
  let posCorr = 0
  let tinyN = 0
  let lastCorrLog = 0
  let ptCount = 0
  let fmCount = 0
  let confCount = 0
  let lastConfId = '-'
  let inTid = '-'
  let ptParsed = null
  let rng = { x: 0, y: 0, z: 0 }
  let samp = null
  const origWrite = b._client.write.bind(b._client)
  let sbPos = 0
  let sbTc = 0
  let rawN = 0
  const sbNames = {}
  b._client.write = (name, data) => {
    sbNames[name] = (sbNames[name] || 0) + 1
    if (name === 'teleport_confirm') {
      confCount++; lastConfId = data.teleportId; sbTc++
      if (confCount <= 3) send({ evt: 'log', msg: 'sb confirm#' + confCount + ' id=' + data.teleportId })
    }
    if (name === 'position' || name === 'position_look') {
      sbPos++
      outPosN++
      const orig = 'x=' + data.x + ' y=' + data.y + ' z=' + data.z + ' og=' + data.onGround
      let delta = ''
      if (lastTp) {
        const d = (a, b) => Math.abs(a - b).toExponential(1)
        delta = ' dtp=' + d(data.x, lastTp.x) + ',' + d(data.y, lastTp.y) + ',' + d(data.z, lastTp.z)
      }
      if (outPosN <= 5 || outPosN % 200 === 0 || (echoExactUntil && outPosN === 1)) {
        send({ evt: 'log', msg: 'out#' + outPosN + ' ' + name + ' ' + orig + delta + (Date.now() < echoExactUntil ? ' [exact]' : '') })
      }
      if (Date.now() < echoExactUntil && lastTp) {
        data = Object.assign({}, data, { x: lastTp.x, y: lastTp.y, z: lastTp.z, onGround: true })
      }
    }
    if ((name === 'position' || name === 'position_look' || name === 'flying') && Date.now() < silentMoveUntil) {
      dropN++
      if (dropN === 1) send({ evt: 'log', msg: 'SILENT-MOVE on (dropping ' + name + ')' })
      if (dropN % 50 === 0) send({ evt: 'log', msg: 'SILENT-MOVE dropped=' + dropN + ' last=' + name })
      return
    }
    // og test: never claim airborne — force onGround=true on all movement packets
    if ((name === 'position' || name === 'position_look' || name === 'flying') && data && data.onGround === false) {
      data.onGround = true
      ogForceN++
      if (ogForceN === 1 || ogForceN % 200 === 0) send({ evt: 'log', msg: 'OG-FORCE #' + ogForceN + ' (' + name + ') og=false -> true' })
    }
    return origWrite(name, data)
  }
  b._client.on('raw.position', (buffer) => {
    rawN++
    if (rawN <= 6 || rawN % 50 === 0) {
      let i = 0
      let val = 0
      let shift = 0
      let byte = 0
      do { byte = buffer[i++]; val |= (byte & 0x7f) << shift; shift += 7 } while ((byte & 0x80) && i < 5)
      const mTid = val | 0
      let m = { x: NaN, y: NaN, z: NaN }
      try { m = { x: buffer.readDoubleBE(i), y: buffer.readDoubleBE(i + 8), z: buffer.readDoubleBE(i + 16) } } catch (e) {}
      let alt = { x: NaN, y: NaN, z: NaN }
      try { alt = { x: buffer.readDoubleBE(6), y: buffer.readDoubleBE(14), z: buffer.readDoubleBE(22) } } catch (e) {}
      const r10 = (n) => Math.round(n * 10) / 10
      send({ evt: 'log', msg: 'raw#' + rawN + ' ver=' + b._client.version + ' len=' + buffer.length +
        ' hex=' + buffer.toString('hex') +
        ' A[ tid=' + mTid + ' x=' + r10(m.x) + ' y=' + r10(m.y) + ' z=' + r10(m.z) + ']' +
        ' B[ pre=' + buffer.slice(0, 6).toString('hex') + ' x6=' + r10(alt.x) + ' y14=' + r10(alt.y) + ' z22=' + r10(alt.z) + ']' +
        ' P[ tid=' + (ptParsed ? ptParsed.tid : '?') + ' x=' + (ptParsed ? r10(ptParsed.x) : '?') +
        ' y=' + (ptParsed ? ptParsed.y : '?') + ' z=' + (ptParsed ? ptParsed.z : '?') + ']' })
    }
  })
  b.on('physicsTick', () => {
    ptCount++
    const p = b.entity.position
    if (!samp) samp = { x0: p.x, x1: p.x, y0: p.y, y1: p.y, z0: p.z, z1: p.z }
    if (p.x < samp.x0) samp.x0 = p.x
    if (p.x > samp.x1) samp.x1 = p.x
    if (p.y < samp.y0) samp.y0 = p.y
    if (p.y > samp.y1) samp.y1 = p.y
    if (p.z < samp.z0) samp.z0 = p.z
    if (p.z > samp.z1) samp.z1 = p.z
  })
  b.on('forcedMove', () => { fmCount++ })
  const onPositionCorr = (data) => {
    posCorr++
    inTid = data.teleportId
    ptParsed = { tid: data.teleportId, x: data.x, y: data.y, z: data.z }
    lastTp = { x: data.x, y: data.y, z: data.z }
    const now = Date.now()
    // sync pings: the server echoes our own position back ~6x/s (outbound
    // dtp=0, displacement ~0). treating those as corrections re-armed
    // _holdUntil on every packet, so the hold never expired while the stream
    // ran and taskGoto never re-issued -> "bots can't move". only a snap that
    // actually displaces us is a real correction.
    let disp = 999
    try { const p = b.entity.position; disp = Math.hypot(p.x - data.x, p.y - data.y, p.z - data.z) } catch (e) {}
    const tiny = disp < 0.1
    if (tiny) {
      tinyN++
      if (tinyN === 1 || tinyN % 500 === 0) send({ evt: 'log', msg: 'sync-ping skip #' + tinyN + ' disp=' + disp.toFixed(3) + ' (no hold)' })
    }
    corrStamps = corrStamps.filter(ts => now - ts < 1000)
    if (!tiny) corrStamps.push(now)
    if (!tiny && !silentUsed && corrStamps.length >= 3) {
      if (!stormStart) {
        stormStart = now
        send({ evt: 'log', msg: 'SILENT-AUTO storm detected (3 corr <1s), watching 5s' })
      } else if (now - stormStart >= 5000) {
        silentUsed = true
        silentMoveUntil = now + 15000
        dropN = 0
        send({ evt: 'log', msg: 'SILENT-AUTO armed 15s, no outbound movement' })
        setTimeout(() => {
          send({ evt: 'log', msg: 'SILENT-AUTO expired, movement resumed' })
          if (Date.now() < beatUntil) {
            send({ evt: 'log', msg: 'SILENT-AUTO echo skipped (BEAT active)' })
            return
          }
          echoExactUntil = Date.now() + 30000
          outPosN = 0
          send({ evt: 'log', msg: 'ECHO-EXACT armed 30s, echoing server tp target verbatim' })
          setTimeout(() => {
            echoExactUntil = 0
            send({ evt: 'log', msg: 'ECHO-EXACT expired, normal echo' })
          }, 30000)
        }, 15000)
      }
    }
    if (now - lastCorrLog > 1500) {
      lastCorrLog = now
      let walls = 'err'
      try {
        const p = b.entity.position
        const nm = (o) => { const x = b.blockAt(o); return x ? x.name : 'NULL' }
        walls = 'E' + nm(p.offset(1, 0, 0)).slice(0, 4) +
          ' W' + nm(p.offset(-1, 0, 0)).slice(0, 4) +
          ' N' + nm(p.offset(0, 0, -1)).slice(0, 4) +
          ' S' + nm(p.offset(0, 0, 1)).slice(0, 4) +
          ' D' + nm(p.offset(0, -1, 0)).slice(0, 4) +
          ' U' + nm(p.offset(0, 1, 0)).slice(0, 4)
      } catch (e) { walls = 'err' }
      const r = samp ? ((samp.x1 - samp.x0) + (samp.y1 - samp.y0) + (samp.z1 - samp.z0)).toFixed(3) : '-'
      const ow = Object.keys(sbNames).map((k) => k.slice(0, 14) + ':' + sbNames[k]).join(',')
      send({ evt: 'log', msg: 'dbg pos corr#' + posCorr + ' tid=' + inTid +
        ' cf=' + confCount + ' out=' + lastConfId +
        ' pt=' + ptCount + ' fm=' + fmCount + ' rng=' + r + ' d=' + disp.toFixed(3) +
        ' sb=' + sbPos + '/' + sbTc + ' [' + walls + ']' + (ow ? ' OW{' + ow + '}' : '') })
      ptCount = 0
      fmCount = 0
      sbPos = 0
      sbTc = 0
      for (const k of Object.keys(sbNames)) delete sbNames[k]
      samp = null
    }
    if (Date.now() >= defyUntil && !tiny) {
      if (Date.now() < (b._holdUntil || 0)) {
        // real correction during an active hold: re-path once it expires,
        // but first-wins - never extend, or a yank stream freezes goto b._needReissue = true
      } else {
        b._holdUntil = Date.now() + rnd(300, 700)
        b._needReissue = true
        try { if (b.pathfinder.isMoving()) b.pathfinder.stop() } catch (e) {}
      }
    } else {
      // defying: snap never applied. tiny sync ping: nothing to correct -
      // hands off the pathfinder so walk tasks keep driving
    }
  }
  b._client.on('position', onPositionCorr)

  // 45s inbound packet-name window (armed by lclick) - hunt server instructions
  // / ping-acks / anything explaining the correction storm
  const PKT_SKIP = new Set([
    'position', 'position_look', 'keep_alive', 'bundle_delimiter', 'update_time',
    'teleport_confirm', 'pong', 'ping',
    'rel_entity_move', 'entity_move_look', 'entity_velocity', 'sync_entity_position',
    'update_entity_position', 'update_entity_position_rotation', 'update_entity_rotation',
    'set_entity_motion', 'entity_metadata', 'update_attributes', 'entity_head_rotation',
    'sound', 'sound_effect', 'world_event', 'particle', 'animate', 'set_equipment', 'update_step_sound',
    'block_update', 'multi_block_change', 'update_light', 'level_chunk_with_light',
    'map_chunk', 'update_view_position', 'update_view_distance', 'chunk_batch_ack',
    'entity_status', 'playerlist_header', 'player_info', 'player_remove'
  ])
  b._client.on('packet', (data, meta) => {
    if (Date.now() >= pktlogUntil) return
    const nm = meta && meta.name
    if (!nm || PKT_SKIP.has(nm)) return
    let s = ''
    try { s = JSON.stringify(data) } catch (e) { s = '' }
    if (s.length > 220) s = s.slice(0, 220) + '...'
    send({ evt: 'log', msg: 'pkt ' + nm + ' ' + s })
  })

  // dig tracing: server acks for the exact blocks we're awaiting (status 0=started 1=finished 2=cancelled)
  b._client.on('packet', (data, meta) => {
    const nm = meta && meta.name
    if (nm !== 'acknowledge_player_digging' && nm !== 'block_update' && nm !== 'block_change' && nm !== 'multi_block_change') return
    let watched = false
    if (nm === 'acknowledge_player_digging') watched = true
    const loc = data.location
    if (loc && digWatch.has(loc.x + ',' + loc.y + ',' + loc.z)) watched = true
    if (data.records && data.records.length) {
      for (const r of data.records) {
        const p = r.position
        if (p && digWatch.has(p.x + ',' + p.y + ',' + p.z)) watched = true
      }
    }
    if (!watched) return
    let s = ''
    try { s = JSON.stringify(data) } catch (e) { s = '' }
    if (s.length > 170) s = s.slice(0, 170) + '...'
    send({ evt: 'log', msg: 'DIG-PKT ' + nm + ' ' + s })
  })

  bot.on('diggingCompleted', (blk) => send({ evt: 'log', msg: 'digEvt completed ' + fmtPos(blk.position) }))
  bot.on('diggingAborted', (blk) => send({ evt: 'log', msg: 'digEvt aborted ' + fmtPos(blk.position) }))
  bot.on('entitySpawn', (e) => {
    if (e.type !== 'item' || !bot.entity) return
    const d = e.position.distanceTo(bot.entity.position)
    send({ evt: 'log', msg: 'drop d=' + d.toFixed(1) + ' @' + Math.floor(e.position.x) + ',' + Math.floor(e.position.y) + ',' + Math.floor(e.position.z) + (e.itemId ? ' ' + e.itemId : '') })
  })

  // chat/server spam hidden from console by default; TUI "chat" button flips
  // chatFilter live via {cmd:'filter'}
  b.on('messagestr', (str) => {
    if (!chatFilter || Date.now() < pktlogUntil) send({ evt: 'log', msg: str })
  })

  // server command tree (vanilla + plugins) on join -> one log line of /cmd names
  b._client.on('declare_commands', (packet) => {
    try {
      const nodes = packet.nodes || []
      const root = nodes[packet.rootIndex]
      if (!root || !root.children) return
      const names = []
      for (const i of root.children) {
        const nd = nodes[i] && nodes[i].extraNodeData
        if (nd && nd.name && names.indexOf(nd.name) < 0) names.push(nd.name)
      }
      if (names.length) send({ evt: 'log', msg: 'cmds(' + names.length + '): ' + names.join(' ') })
    } catch (e) {}
  })

  // show replies to our own '/' commands even while chat filter hides chat
  b._client.on('system_chat', (data) => {
    if (Date.now() - lastCmdAt > 5000) return
    let s = ''
    try { s = jsonToText(data.content) } catch (e) { s = '' }
    s = s.replace(/\s+/g, ' ').trim()
    if (!s) { try { s = JSON.stringify(data.content) } catch (e) { s = '' } }
    if (s.length > 300) s = s.slice(0, 300) + '...'
    if (s) send({ evt: 'log', msg: 'cmd-reply: ' + s })
  })
}

// flatten NBT-as-json / chat components to plain text
function jsonToText (n) {
  if (n == null) return ''
  if (typeof n === 'string') return n
  if (typeof n === 'number' || typeof n === 'boolean') return String(n)
  if (Array.isArray(n)) return n.map(jsonToText).join('')
  if (typeof n === 'object') {
    if (n.type === 'string') return String(n.value == null ? '' : n.value)
    if (n.type === 'list') return jsonToText(n.value)
    if (n.type === 'compound') return jsonToText(n.value)
    let out = ''
    if (n.text !== undefined) out += jsonToText(n.text)
    if (n.extra !== undefined) out += jsonToText(n.extra)
    return out
  }
  return ''
}

async function resolveSrvHost (host, port) {
  if (port !== 25565 || net.isIP(host) || host === 'localhost') return { host, port }
  const ask = (resolver) => new Promise((res) => {
    try {
      resolver.resolveSrv('_minecraft._tcp.' + host, (err, addrs) => {
        res(!err && addrs && addrs.length
          ? { host: addrs[0].name, port: parseInt(addrs[0].port, 10) }
          : null)
      })
    } catch (e) { res(null) }
  })
  let hit = null
  try { hit = await ask(dns) } catch (e) {}
  if (!hit) {
    try {
      const pub = new dns.Resolver()
      pub.setServers(['1.1.1.1', '8.8.8.8'])
      hit = await ask(pub)
    } catch (e) {}
  }
  return hit || { host, port }
}

async function doJoin (msg) {
  if (bot) doLeave()
  send({ evt: 'status', state: 'connecting', detail: msg.server })
  const parts = msg.server.split(':')
  const rawPort = parseInt(parts[1] || '25565', 10)
  let host = parts[0]
  let port = rawPort
  try {
    const t = await resolveSrvHost(host, rawPort)
    if (t.host !== host || t.port !== port) {
      send({ evt: 'log', msg: 'srv -> ' + t.host + ':' + t.port })
    }
    host = t.host
    port = t.port
  } catch (e) {
    send({ evt: 'log', msg: 'srv failed: ' + e.message })
  }
  bot = mineflayer.createBot({
    host: host,
    port: port,
    username: msg.name,
    auth: tokenAuth(msg.token, { uuid: msg.uuid, name: msg.name }),
    brand: 'vanilla',
    version: false,
    hideErrors: true,
    respawn: true,
    checkTimeoutInterval: 60000,
    skipChatSignals: false
  })
  wire(bot)
}

function doLeave () {
  stopTask()
  if (bot) {
    try { bot.quit('leaving') } catch (e) {}
    try { bot.end('leaving') } catch (e) {}
    bot = null
  }
  send({ evt: 'status', state: 'offline', detail: 'left' })
}

function stopTask () {
  if (task) task.cancelled = true
  task = null
  if (bot && bot.pathfinder) {
    try { bot.pathfinder.stop() } catch (e) {}
    for (const k of ['forward', 'back', 'left', 'right', 'jump', 'sprint']) {
      try { bot.setControlState(k, false) } catch (e) {}
    }
  }
}

function progress (detail) {
  if (task) send({ evt: 'task', id: task.id, state: 'progress', detail })
}

async function waitStart (startAt) {
  if (!startAt) return
  const delay = startAt - Date.now()
  if (delay > 0) await sleep(delay)
}

async function taskGoto (t, args) {
  const targetName = args.player
  let entity = targetName ? bot.players[targetName] && bot.players[targetName].entity : null
  const timeout = (args.timeout || 60) * 1000
  const deadline = Date.now() + timeout

  if (!entity && targetName) {
    for (let i = 0; i < 40 && !cancelled(); i++) {
      await sleep(500)
      entity = bot.players[targetName] && bot.players[targetName].entity
      if (entity) break
    }
  }
  if (cancelled()) return
  if (targetName && !entity) throw new Error('player not found: ' + targetName)

  // script.py passes minecraft-style ~ / ~2 axes through as strings
  const cur = bot.entity.position
  const ax = (v, d) => (typeof v === 'string' && v.charAt(0) === '~')
    ? d + (v.length > 1 ? parseFloat(v.slice(1)) : 0) : v
  const pos = entity ? entity.position
    : require('vec3')(ax(args.x, cur.x), ax(args.y, cur.y), ax(args.z, cur.z))
  const range = args.range ?? 1
  const goal = entity
    ? new goals.GoalNear(pos.x, pos.y, pos.z, range)
    : new goals.GoalBlock(Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z))
  const reach = entity ? range + 0.5 : 0.75
  bot.pathfinder.setMovements(makeMovements(bot))
  bot.pathfinder.goto(goal).catch(() => {})
  progress('walking to target')
  bot._moving = true

  try {
    while (!cancelled()) {
      await sleep(400)
      if (Date.now() < (bot._holdUntil || 0)) continue // hit or grim correction: hands off
      if (bot._needReissue) {
        bot._needReissue = false
        bot.pathfinder.goto(goal).catch(() => {})
      }
      const p = bot.entity.position
      if (Math.hypot(p.x - pos.x, p.z - pos.z) <= reach && Math.abs(p.y - pos.y) < 2) break
      if (Date.now() > deadline) throw new Error('goto timeout')
      if (entity) {
        const g = new goals.GoalNear(entity.position.x, entity.position.y, entity.position.z, range)
        bot.pathfinder.goto(g).catch(() => {})
      }
    }
  } finally {
    bot._moving = false
  }
  if (!cancelled()) progress('arrived ' + fmtPos(bot.entity.position))
}

async function taskWander (t, args) {
  const radius = args.radius ?? 24
  const pauses = args.pauses !== false
  progress('wander started r=' + radius + (bot.vehicle ? ' [mounted]' : ''))

  while (!cancelled()) {
    const c = bot.entity.position
    const ang = rnd(0, Math.PI * 2)
    const dist = rnd(radius * 0.3, radius)
    const x = Math.floor(c.x + Math.cos(ang) * dist)
    const z = Math.floor(c.z + Math.sin(ang) * dist)
    const y = c.y
    bot.pathfinder.setMovements(makeMovements(bot))
    let settled = false
    let why = 'walking'
    const startPos = bot.entity.position.clone()
    bot.pathfinder.goto(new goals.GoalXZ(x, z)).then(
      () => { settled = true; why = 'arrived' },
      (e) => { settled = true; why = 'failed: ' + String((e && e.message) || e).slice(0, 60) }
    )
    while (!cancelled()) {
      await sleep(500)
      const p = bot.entity.position
      if (Math.hypot(p.x - x, p.z - z) < 2) { why = 'arrived'; break }
      if (!settled) continue
      break
    }
    if (cancelled()) return
    const d = Math.hypot(bot.entity.position.x - startPos.x, bot.entity.position.z - startPos.z)
    progress('walked ' + d.toFixed(1) + 'b of tgt ' + x + ',' + z + ' (' + why + ')')
    if (pauses) {
      progress('pausing')
      await sleep(rnd(1500, 5000))
      if (Math.random() < 0.6) {
        try { await bot.look(bot.entity.yaw + rnd(-1.2, 1.2), rnd(-0.3, 0.2), false) } catch (e) {}
      }
    }
  }
}

function isDepositable (it) {
  const n = (it.name || '').toLowerCase()
  if (/pickaxe|axe|shovel|sword|shears|bow|arrow|helmet|chestplate|leggings|boots|shield|totem/.test(n)) return false
  return true
}

async function findChest (radius) {
  const chests = bot.findBlock({
    matching: (blk) => blk.name && blk.name.endsWith('_chest'),
    maxDistance: radius || 32
  })
  return chests
}

async function doDeposit (args) {
  const chest = await findChest(args.chestRadius || 32)
  if (!chest) { progress('no chest found, keeping items'); return false }

  bot.pathfinder.setMovements(makeMovements(bot))
  const p = chest.position
  await bot.pathfinder.goto(new goals.GoalNear(p.x, p.y, p.z, 3))
  if (cancelled()) return false

  const chestWindow = await bot.openChest(chest)
  await sleep(rnd(300, 700))
  let moved = 0
  for (const item of [...chestWindow.containerItems(), ...chestWindow.items()]) {
    if (cancelled()) break
    if (!item || !isDepositable(item)) continue
    try {
      await chestWindow.deposit(item.type, item.metadata, item.count)
      moved++
      await sleep(rnd(150, 450))
    } catch (e) {}
  }
  await sleep(rnd(300, 600))
  try { chestWindow.close() } catch (e) {}
  progress('deposited ' + moved + ' stacks')
  return true
}

async function taskMine (t, args) {
  const radius = args.radius ?? 3
  const layers = args.layers ?? 1
  const c = bot.entity.position.floored()
  const targets = []

  const names = new Set()
  let nullN = 0
  for (let dy = -1; dy < layers; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dz = -radius; dz <= radius; dz++) {
        const pos = require('vec3')(c.x + dx, c.y + dy, c.z + dz)
        const blk = bot.blockAt(pos)
        if (!blk) { nullN++ } else { names.add(blk.name) }
        if (!blk || blk.boundingBox === 'empty') continue
        if (blk.name === 'air' || blk.name === 'cave_air') continue
        if (/bedrock|chest|sign|door|torch|lantern/.test(blk.name)) continue
        if (blk.hardness === -1) continue
        targets.push({ pos, dist: dx * dx + dz * dz + dy * dy })
      }
    }
  }
  send({ evt: 'log', msg: 'scan seen=' + [...names].join(',') + ' null=' + nullN })
  targets.sort((a, b) => a.dist - b.dist)
  progress('mining ' + targets.length + ' blocks')

  let mined = 0
  for (const t2 of targets) {
    if (cancelled()) return
    const blk = bot.blockAt(t2.pos)
    if (!blk) continue
    const wkey = t2.pos.x + ',' + t2.pos.y + ',' + t2.pos.z
    try {
      if (bot.tool) await bot.tool.equipForBlock(blk)
      const t0 = Date.now()
      const wt = bot.digTime(blk)
      const eff = Object.entries(bot.entity.effects || {})
        .map(([k, v]) => k + ':' + (v.amplifier + 1)).join(',')
      digWatch.set(wkey, t0)
      send({ evt: 'log', msg: 'dig start ' + wkey + ' ' + blk.name + ' wait=' + wt + ' og=' + (bot.entity.onGround ? 1 : 0) + ' held=' + (bot.heldItem ? bot.heldItem.name : 'hand') + ' eff=' + (eff || '-') })
      await bot.dig(blk)
      digWatch.delete(wkey)
      mined++
      send({ evt: 'log', msg: 'dig done ' + wkey + ' ' + (Date.now() - t0) + 'ms' })
      if (mined % 5 === 0) progress('mined ' + mined + '/' + targets.length)
      await sleep(rnd(80, 350))
    } catch (e) {
      digWatch.delete(wkey)
      digFailN++
      if (digFailN <= 3) send({ evt: 'log', msg: 'dig fail #' + digFailN + ': ' + (e && e.message) })
    }
  }

  const deadline = Date.now() + 25000
  while (!cancelled() && Date.now() < deadline) {
    const items = Object.values(bot.entities).filter(e => e.type === 'item' &&
      e.position.distanceTo(bot.entity.position) < radius + 6)
    if (!items.length) break
    for (const it of items) {
      if (cancelled()) break
      try {
        bot.pathfinder.goto(new goals.GoalNear(it.position.x, it.position.y, it.position.z, 1.2)).catch(() => {})
        await sleep(600)
      } catch (e) {}
    }
    await sleep(500)
  }

  progress('collected, mined ' + mined)
  if (args.deposit !== false) await doDeposit(args)
  return true
}

async function taskFollow (t, args) {
  const name = args.player
  if (!name) throw new Error('follow needs player')
  let entity = bot.players[name] && bot.players[name].entity
  const deadline = Date.now() + 30000
  while (!entity && Date.now() < deadline && !cancelled()) {
    await sleep(500)
    entity = bot.players[name] && bot.players[name].entity
  }
  if (!entity) throw new Error('player not found: ' + name)
  const range = args.range ?? 3

  while (!cancelled()) {
    const e = bot.players[name] && bot.players[name].entity
    if (e) {
      bot.pathfinder.setMovements(makeMovements(bot))
      const dist = bot.entity.position.distanceTo(e.position)
      if (dist > range + 2) {
        bot.pathfinder.goto(new goals.GoalNear(e.position.x, e.position.y, e.position.z, range)).catch(() => {})
      }
    }
    await sleep(1200)
  }
}

function releaseControls () {
  if (!bot) return
  for (const c of ['forward', 'back', 'left', 'right', 'jump', 'sneak', 'sprint']) {
    try { bot.setControlState(c, false) } catch (e) {}
  }
}

async function taskMove (t, args) {
  const dirs = ['forward', 'back', 'left', 'right']
  const dir = dirs.includes(args.dir) ? args.dir : 'forward'
  const blocks = Math.min(64, Math.max(1, Number(args.blocks) || 1))
  progress('moving ' + dir + ' ' + blocks + 'b' + (bot.vehicle ? ' [mounted ' + (bot.vehicle.name || 'veh') + ']' : ' [on foot]'))
  await sleep(rnd(120, 450))
  if (cancelled()) return
  const start = bot.entity.position.clone()
  releaseControls()
  bot.setControlState(dir, true)
  if (dir === 'forward' && Math.random() < 0.35) bot.setControlState('sprint', true)
  const timeout = Date.now() + blocks * 2600 + 1800
  let lastDbg = 0
  let dist = 0
  while (!cancelled() && Date.now() < timeout) {
    const p = bot.entity.position
    const dx = p.x - start.x
    const dz = p.z - start.z
    dist = Math.sqrt(dx * dx + dz * dz)
    if (dist >= blocks - 0.35 && Math.abs(p.y - start.y) < 1.6) break
    if (Date.now() - lastDbg > 1200) {
      lastDbg = Date.now()
      send({ evt: 'log', msg: 'dbg move d=' + dist.toFixed(2) + '/' + blocks +
        ' @' + fmtPos(p) + ' ctl=' + (bot.getControlState ? bot.getControlState('forward') : '?') +
        ' mount=' + (bot.vehicle ? 1 : 0) })
    }
    await sleep(60)
  }
  releaseControls()
  progress('moved ' + dist.toFixed(1) + 'b of ' + blocks + 'b')
}

async function taskLook (t, args) {
  const yaw = Number(args.yaw)
  const pitch = Number(args.pitch || 0)
  if (!isFinite(yaw)) throw new Error('look needs yaw degrees')
  await sleep(rnd(80, 300))
  if (cancelled()) return
  await bot.look(yaw * Math.PI / 180, pitch * Math.PI / 180, false)
}

async function taskJump (t) {
  await sleep(rnd(60, 250))
  if (cancelled()) return
  bot.setControlState('jump', true)
  await sleep(rnd(90, 170))
  bot.setControlState('jump', false)
}

function stripCodes (s) {
  return String(s).replace(/§./g, '').trim()
}

// some npc names are made ONLY of formatting codes (e.g. §2§l§m§5§0§f§4§k) so
// stripCodes() returns '' - fall back to bare-characters so they stay visible
function entDisplayName (e) {
  const raw = String((e && (e.username || e.name)) || '')
  const s = stripCodes(raw)
  if (s) return s
  if (raw) return raw.replace(/§/g, '')
  return 'ent' + (e && e.entityType != null ? e.entityType : '?') + '#' + (e && e.id != null ? e.id : '?')
}

function fmtPos (p) {
  return p.x.toFixed(1) + ',' + p.y.toFixed(1) + ',' + p.z.toFixed(1)
}

function compText (c) {
  if (typeof c === 'string') return c
  if (Array.isArray(c)) { let s = ''; for (const x of c) s += compText(x); return s }
  if (!c || typeof c !== 'object') return ''
  let s = ''
  if (typeof c.text === 'string') s += c.text
  if (typeof c.translate === 'string') s += c.translate
  if (typeof c.selector === 'string') s += c.selector
  if (c.extra) s += compText(c.extra)
  return s
}

function entText (e) {
  try {
    if (!/text_display/i.test(String(e.name || ''))) return ''
    for (const v of (e.metadata || [])) {
      const s = stripCodes(compText(v))
      if (s && s.trim()) return ' "' + s.slice(0, 40) + '"'
    }
  } catch (err) {}
  return ''
}

function findEntityByName (name) {
  if (!name || !bot || !bot.entities) return null
  const want = stripCodes(name).toLowerCase().replace(/§/g, '')
  const cands = Object.values(bot.entities).filter(e => {
    if (e === bot.entity) return false
    const dn = entDisplayName(e).toLowerCase()
    return dn === want || (e.username && stripCodes(e.username).toLowerCase() === want) ||
      (e.name && stripCodes(e.name).toLowerCase() === want)
  })
  if (!cands.length) return null
  const mePos = bot.entity && bot.entity.position
  if (mePos) cands.sort((a, b) =>
    a.position.distanceTo(mePos) - b.position.distanceTo(mePos))
  return cands[0]
}

async function taskRclick (t, args) {
  await sleep(rnd(80, 320))
  if (cancelled()) return
  const want = args && args.player
  let acted = false
  let target = null
  if (want) {
    target = findEntityByName(want)
    if (!target) throw new Error('no entity named ' + want)
  } else if (bot.entityAtCursor) {
    const at = bot.entityAtCursor()
    if (at && at !== bot.entity) target = at
  }
  // cursor missed - turn to the closest interactable thing in reach instead
  // (npcs sit at odd angles when we spawn; same fallback lclick uses)
  if (!target && !want && bot.entity) {
    const eyes = bot.entity.position.offset(0, (bot.entity.height || 1.62) * 0.85, 0)
    const cp = Math.cos(bot.entity.pitch)
    const dir = {
      x: -Math.sin(bot.entity.yaw) * cp,
      y: -Math.sin(bot.entity.pitch),
      z: Math.cos(bot.entity.yaw) * cp
    }
    const cands = []
    for (const e of Object.values(bot.entities)) {
      if (!e || !e.position || e === bot.entity) continue
      const nm = entDisplayName(e)
      if (!nm || NEAR_NOISE.test(nm)) continue
      if (/text_display/i.test(String(e.name || ''))) continue
      const aim = e.position.offset(0, (e.height || 1) * 0.5, 0)
      const v = aim.minus(eyes)
      const d = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z)
      if (!isFinite(d) || d < 0.05 || d > 4.2) continue
      cands.push({ e, d, dot: (v.x * dir.x + v.y * dir.y + v.z * dir.z) / d })
    }
    const cone = cands.filter(c => c.dot > Math.cos(0.25)).sort((a, b) => b.dot - a.dot)
    if (cone.length) target = cone[0].e
    else if (cands.length) {
      cands.sort((a, b) => a.d - b.d)
      target = cands[0].e
    }
  }
  if (target && target.position) {
    try {
      const eye = target.position.offset(0, target.height ? target.height * 0.85 : 1.0, 0)
      await bot.lookAt(eye)
      if (cancelled()) return
      bot.swingArm('right')
      await bot.activateEntity(target)
      progress('clicked ' + (target.username || target.name || 'entity'))
      acted = true
    } catch (e) {
      if (want) throw new Error('click ' + want + ': ' + (e.message || e))
    }
  }
  if (!acted && !want) {
    try {
      const blk = bot.blockAtCursor ? bot.blockAtCursor(4.5) : null
      if (blk) {
        bot.swingArm('right')
        await bot.activateBlock(blk)
        progress('clicked block ' + blk.name + ' @' + fmtPos(blk.position))
        acted = true
      }
    } catch (e) {}
  }
  if (!acted && !want) {
    try { await bot.useEquippedItem() } catch (e) {}
    bot.swingArm('right')
    progress('swung at nothing (no entity/block in reach)')
  }
  await sleep(rnd(150, 400))
}

async function taskLclick (t, args) {
  await sleep(rnd(80, 320))
  if (cancelled()) return
  pktlogUntil = Date.now() + 45000
  silentMoveUntil = 0
  silentUsed = false
  echoExactUntil = 0
  outPosN = 0
  stormStart = 0
  corrStamps = []
  dropN = 0
  defyUntil = 0
  defySnapN = 0
  beatUntil = 0
  ogForceN = 0
  digFailN = 0
  send({ evt: 'log', msg: 'pktlog armed 45s, storm test: silence 15s -> exact-echo 30s -> normal' })
  const want = args && args.player
  if (want) {
    const target = findEntityByName(want)
    if (!target) throw new Error('no entity named ' + want)
    await bot.lookAt(target.position.offset(0, target.height ? target.height * 0.85 : 1.0, 0))
    if (cancelled()) return
    bot.swingArm('right')
    try { bot.attack(target) } catch (e) {}
    progress('punched ' + entDisplayName(target) + ' @' + fmtPos(target.position))
    await sleep(rnd(350, 700))
    return
  }
  const target = bot.entityAtCursor ? bot.entityAtCursor() : null
  if (target && target !== bot.entity) {
    try { await bot.lookAt(target.position.offset(0, (target.height || 1) * 0.8, 0)) } catch (e) {}
    if (cancelled()) return
    bot.swingArm('right')
    try { bot.attack(target) } catch (e) {}
    progress('punched ' + entDisplayName(target) + ' @' + fmtPos(target.position))
    await sleep(rnd(350, 700))
    return
  }
  // something's standing right in front of us the cursor ray missed (unknown
  // npc types often have no width/height, so mineflayer's ray skips them) -
  // hit it like a vanilla client instead of mining the block behind it
  if (bot.entity) {
    const eyes = bot.entity.position.offset(0, (bot.entity.height || 1.62) * 0.85, 0)
    const cp = Math.cos(bot.entity.pitch)
    const dir = {
      x: -Math.sin(bot.entity.yaw) * cp,
      y: -Math.sin(bot.entity.pitch),
      z: Math.cos(bot.entity.yaw) * cp
    }
    const cands = []
    for (const e of Object.values(bot.entities)) {
      if (!e || !e.position || e === bot.entity) continue
      const nm = entDisplayName(e)
      if (!nm || NEAR_NOISE.test(nm)) continue
      if (/text_display/i.test(String(e.name || ''))) continue
      const aim = e.position.offset(0, (e.height || 1) * 0.5, 0)
      const v = aim.minus(eyes)
      const d = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z)
      if (!isFinite(d) || d < 0.05 || d > 4.2) continue
      cands.push({ e, d, dot: (v.x * dir.x + v.y * dir.y + v.z * dir.z) / d })
    }
    let best = null
    const cone = cands.filter(c => c.dot > Math.cos(0.25)).sort((a, b) => b.dot - a.dot)
    if (cone.length) best = cone[0].e
    else if (cands.length) {
      // nothing under the crosshair - turn to face the closest thing first
      // (like a vanilla client), then hit it
      cands.sort((a, b) => a.d - b.d)
      best = cands[0].e
    }
    if (best) {
      try { await bot.lookAt(best.position.offset(0, (best.height || 1) * 0.7, 0)) } catch (e) {}
      if (cancelled()) return
      bot.swingArm('right')
      try { bot.attack(best) } catch (e) {}
      progress('punched ' + entDisplayName(best) + ' @' + fmtPos(best.position))
      await sleep(rnd(350, 700))
      return
    }
  }
  try {
    const blk = bot.blockAtCursor ? bot.blockAtCursor(4.5) : null
    if (blk && blk.hardness !== -1 && !/barrier|bedrock/i.test(blk.name || '')) {
      progress('digging')
      if (bot.tool) await bot.tool.equipForBlock(blk)
      bot.swingArm('right')
      await bot.dig(blk)
      progress('dug')
      return
    }
    if (blk) progress('block ' + blk.name + " won't break - not digging")
  } catch (e) {}
  bot.swingArm('right')
  progress('nothing punchable in reach')
}

async function taskSwing (t) {
  await sleep(rnd(50, 220))
  bot.swingArm('right')
}

async function taskHold (t, args, which) {
  const on = args.on !== false && args.on !== 'off'
  await sleep(rnd(60, 260))
  if (cancelled()) return
  bot.setControlState(which, on)
}

async function taskDrop (t) {
  const item = bot.inventory && bot.inventory.items ? bot.inventory.items()[0] : null
  if (!item) return
  await sleep(rnd(100, 350))
  if (cancelled()) return
  await bot.tossStack(item)
}

function mcD () {
  return require('minecraft-data')(bot.version)
}

function invCount (ids) {
  let n = 0
  for (const it of bot.inventory.items()) if (ids.includes(it.type)) n += it.count
  return n
}

async function vacuumNear (radius) {
  const items = Object.values(bot.entities).filter(e => e.type === 'item' &&
    e.position.distanceTo(bot.entity.position) < radius)
  for (const it of items.slice(0, 6)) {
    if (cancelled()) return
    try {
      await bot.pathfinder.goto(new goals.GoalNear(it.position.x, it.position.y, it.position.z, 1.2))
      await sleep(300)
    } catch (e) {}
  }
}

async function taskTpa (args) {
  if (!args.player) throw new Error('tpa needs player')
  await sleep(rnd(300, 900))
  bot.chat('/tpa ' + args.player)
  progress('tpa sent to ' + args.player)
}

async function taskTpaccept () {
  await sleep(rnd(300, 900))
  bot.chat('/tpaccept')
  progress('tpaccept sent')
}

async function taskInv () {
  const items = bot.inventory.items()
  if (!items.length) {
    progress('inv empty')
    return true
  }
  const by = {}
  for (const i of items) by[i.name] = (by[i.name] || 0) + i.count
  progress('inv ' + Object.entries(by).map(([n, c]) => n + 'x' + c).join(', '))
  return true
}

const NEAR_NOISE = /^(item|arrow|spectral_arrow|tipped_arrow|fireball|small_fireball|snowball|egg|ender_pearl|experience_orb|lightning_bolt|area_effect_cloud|fishing_bobber|llama_spit|dragon_fireball|shulker_bullet|wither_skull|primed_tnt|falling_block|e[0-9]+)$/

async function taskSilent (t, args) {
  const secs = Number.isFinite(Number(args.s)) ? Number(args.s) : 15
  if (secs > 0) {
    silentMoveUntil = Date.now() + secs * 1000
    dropN = 0
    progress('SILENT-MANUAL armed ' + secs + 's, no outbound movement')
  } else {
    silentMoveUntil = 0
    progress('SILENT cleared')
  }
}

async function taskDefy (t, args) {
  const secs = Number.isFinite(Number(args.s)) ? Number(args.s) : 30
  if (secs > 0) {
    defyUntil = Date.now() + secs * 1000
    defySnapN = 0
    progress('DEFY on ' + secs + 's: ignoring server position snaps (confirm only)')
    setTimeout(() => {
      if (Date.now() >= defyUntil) progress('DEFY expired, server snaps apply again')
    }, secs * 1000 + 50)
  } else {
    defyUntil = 0
    progress('DEFY cleared')
  }
}

async function taskBeat (t, args) {
  const secs = Number.isFinite(Number(args.s)) ? Number(args.s) : 60
  if (secs > 0) {
    // cancel any pending/active auto silence+exact so BEAT owns outbound alone
    silentMoveUntil = 0
    echoExactUntil = 0
    silentUsed = true
    stormStart = 0
    corrStamps = []
    beatUntil = Date.now() + secs * 1000
    progress('BEAT on ' + secs + 's @20Hz position heartbeat (auto-seq suppressed)')
    setTimeout(() => {
      if (Date.now() >= beatUntil) progress('BEAT expired, heartbeat off')
    }, secs * 1000 + 50)
  } else {
    beatUntil = 0
    progress('BEAT cleared')
  }
}

// 20Hz vanilla-style standing heartbeat while BEAT active
setInterval(() => {
  if (!bot || Date.now() >= beatUntil) return
  const c = bot._client
  if (!c || c.state !== 'play') return // never send play packets during login/config
  if (!c.socket || !c.socket.writable) return
  const p = bot.entity && bot.entity.position
  if (!p || !Number.isFinite(p.x)) return
  const og = !!bot.entity.onGround
  c.write('position', {
    x: p.x, y: p.y, z: p.z,
    yaw: (Math.PI - (bot.entity.yaw || 0)) * 180 / Math.PI,
    pitch: -(bot.entity.pitch || 0) * 180 / Math.PI,
    onGround: og,
    flags: { onGround: og, hasHorizontalCollision: undefined }
  })
}, 50)

async function taskNear (t, args) {
  await sleep(rnd(80, 300))
  if (cancelled()) return
  if (!bot.entity) throw new Error('not online')
  const view = (args && args.radius) ? Number(args.radius) : 48
  const hit = 4.0
  const me = bot.entity.position
  const hits = []
  const views = []
  for (const e of Object.values(bot.entities)) {
    if (!e || !e.position || e.id === bot.entity.id) continue
    const nm = entDisplayName(e)
    if (!nm || NEAR_NOISE.test(nm)) continue
    const d = me.distanceTo(e.position)
    if (!isFinite(d) || d > view) continue
    const entry = nm + ' ' + d.toFixed(1) + 'm @' + fmtPos(e.position) + entText(e)
    if (d <= hit) hits.push([d, entry])
    else views.push([d, entry])
  }
  hits.sort((a, b) => a[0] - b[0])
  views.sort((a, b) => a[0] - b[0])
  const fmt = a => a.slice(0, 12).map(x => x[1]).join(', ')
  const total = hits.length + views.length
  send({
    evt: 'log',
    msg: 'near me[' + fmtPos(me) + '] HIT[' + (fmt(hits) || '-') + ']  VIEW[' + (fmt(views) || '-') +
      ']  (' + hits.length + ' in reach, ' + total + ' within ' + view + 'm)'
  })
  progress(hits.length + ' in reach / ' + total + ' in view')
}

async function taskGather (t, args) {
  const D = mcD()
  const what = args.what === 'cobble' ? 'cobble' : 'wood'
  const defCount = what === 'wood' ? 8 : 12
  const want = Math.max(1, Math.min(256, parseInt(args.count, 10) || defCount))
  let blockIds
  let itemIds
  if (what === 'wood') {
    const names = Object.keys(D.blocksByName).filter(n => n === 'log' || n.endsWith('_log'))
    blockIds = names.map(n => D.blocksByName[n].id).filter(id => id != null)
    itemIds = names.map(n => D.itemsByName[n] && D.itemsByName[n].id).filter(id => id != null)
  } else {
    blockIds = [D.blocksByName.stone && D.blocksByName.stone.id].filter(id => id != null)
    itemIds = [D.itemsByName.cobblestone && D.itemsByName.cobblestone.id].filter(id => id != null)
    const pickNames = ['wooden_pickaxe', 'stone_pickaxe', 'iron_pickaxe',
      'golden_pickaxe', 'diamond_pickaxe', 'netherite_pickaxe']
    const pickIds = pickNames.map(n => D.itemsByName[n] && D.itemsByName[n].id)
      .filter(id => id != null)
    if (invCount(pickIds) === 0) throw new Error('need a pickaxe (run prep first)')
  }
  if (!blockIds.length) throw new Error('gather ' + what + ': no block data')
  const deadline = Date.now() + 240000
  const skip = new Set()
  let have = invCount(itemIds)
  progress('gather ' + what + ' ' + have + '/' + want)
  while (!cancelled() && have < want && Date.now() < deadline) {
    const found = bot.findBlocks({
      matching: blockIds,
      maxDistance: what === 'wood' ? 48 : 36,
      count: 8
    })
    const cands = found
      .filter(p => !skip.has(p.x + ',' + p.y + ',' + p.z))
      .sort((a, b) => a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position))
    if (!cands.length) {
      if (have === 0) throw new Error('no ' + (what === 'wood' ? 'trees' : 'stone') + ' reachable')
      break
    }
    const target = cands[0]
    const key = target.x + ',' + target.y + ',' + target.z
    let reached = false
    bot.pathfinder.setMovements(makeMovements(bot))
    bot.pathfinder.goto(new goals.GoalNear(target.x, target.y, target.z, 2.5)).catch(() => {})
    const until = Date.now() + 9000
    while (!cancelled() && Date.now() < until) {
      const p = bot.entity.position
      if (Math.hypot(p.x - target.x, p.z - target.z) <= 3.2 && Math.abs(p.y - target.y) <= 3.5) {
        reached = true
        break
      }
      await sleep(300)
    }
    if (cancelled()) return
    if (!reached) {
      skip.add(key)
      continue
    }
    const blk = bot.blockAt(target)
    try {
      if (blk && bot.tool) await bot.tool.equipForBlock(blk)
      if (blk) await bot.dig(blk)
      await sleep(rnd(150, 400))
    } catch (e) {
      skip.add(key)
    }
    await vacuumNear(7)
    have = invCount(itemIds)
    progress('gather ' + what + ' ' + have + '/' + want)
  }
  if (have <= 0) throw new Error('gather ' + what + ': nothing collected')
  return true
}

async function findCraftTable (dist) {
  const D = mcD()
  const id = D.blocksByName.crafting_table && D.blocksByName.crafting_table.id
  if (id == null) return null
  return bot.findBlock({ matching: [id], maxDistance: dist || 4 })
}

async function placeCraftTable () {
  const D = mcD()
  const itemId = D.itemsByName.crafting_table && D.itemsByName.crafting_table.id
  if (itemId == null) throw new Error('no crafting table data')
  const item = bot.inventory.items().find(i => i.type === itemId)
  if (!item) throw new Error('no crafting table in inventory')
  await bot.equip(item, 'hand')
  await sleep(rnd(200, 500))
  const p = bot.entity.position.floored()
  const spots = []
  for (let dx = -2; dx <= 2; dx++) {
    for (let dz = -2; dz <= 2; dz++) {
      for (let dy = -1; dy <= 2; dy++) {
        if (dx === 0 && dy === 0 && dz === 0) continue
        const cell = require('vec3')(p.x + dx, p.y + dy, p.z + dz)
        const above = bot.blockAt(cell)
        const below = bot.blockAt(cell.down())
        if (!above || above.boundingBox !== 'empty') continue
        if (!below || below.boundingBox === 'empty') continue
        if (below.name === 'water' || below.name === 'lava') continue
        spots.push({ below, d: dx * dx + dy * dy + dz * dz })
      }
    }
  }
  if (!spots.length) throw new Error('no room to place crafting table')
  spots.sort((a, b) => a.d - b.d)
  await bot.placeBlock(spots[0].below, require('vec3')(0, 1, 0))
  await sleep(rnd(300, 600))
  const t = await findCraftTable(5)
  if (!t) throw new Error('table placement failed')
  progress('placed crafting table')
  return t
}

async function taskCraft (t, args) {
  const D = mcD()
  const aliases = {
    planks: 'planks', sticks: 'sticks', table: 'table',
    woodpick: 'woodpick', wooden_pickaxe: 'woodpick',
    stonepick: 'stonepick', stone_pickaxe: 'stonepick'
  }
  const what = aliases[String(args.what || '').toLowerCase()]
  if (!what) throw new Error('craft: unknown ' + args.what)

  const item = (name) => {
    const it = D.itemsByName[name]
    if (!it) throw new Error('no data for ' + name)
    return it
  }
  const plankNames = Object.keys(D.itemsByName).filter(n => n.endsWith('_planks'))
  const plankIds = plankNames.map(n => D.itemsByName[n].id)
  const plankCount = () => invCount(plankIds)
  const stickId = item('stick').id

  const craftOnce = async (itm, table) => {
    const rs = bot.recipesFor(itm.id, null, 1, table || null)
    if (!rs.length) return false
    await bot.craft(rs[0], 1, table || null)
    await sleep(rnd(250, 550))
    return true
  }
  const ensurePlanks = async (n) => {
    let tries = 0
    while (plankCount() < n && !cancelled()) {
      let made = false
      for (const name of plankNames) {
        if (await craftOnce(D.itemsByName[name], null)) { made = true; break }
      }
      if (!made) throw new Error('need logs for planks')
      if (++tries > 64) throw new Error('planks craft stuck')
    }
  }
  const ensureSticks = async (n) => {
    let tries = 0
    while (invCount([stickId]) < n && !cancelled()) {
      if (await craftOnce(item('stick'), null)) { tries++; continue }
      await ensurePlanks(plankCount() + 2)
      if (!(await craftOnce(item('stick'), null))) throw new Error('cannot craft sticks')
      if (++tries > 64) throw new Error('sticks craft stuck')
    }
  }

  if (what === 'planks') {
    const want = Math.max(4, Math.min(64, parseInt(args.count, 10) || 4))
    await ensurePlanks(want)
    progress('planks ' + plankCount())
    return true
  }
  if (what === 'sticks') {
    const want = Math.max(2, Math.min(32, parseInt(args.count, 10) || 4))
    await ensureSticks(want)
    progress('sticks ' + invCount([stickId]))
    return true
  }
  if (what === 'table') {
    const near = await findCraftTable(4)
    if (near) { progress('table already placed'); return true }
    if (invCount([item('crafting_table').id]) === 0) {
      await ensurePlanks(4)
      if (!(await craftOnce(item('crafting_table'), null))) throw new Error('cannot craft table')
    }
    await placeCraftTable()
    return true
  }

  const pickName = what === 'woodpick' ? 'wooden_pickaxe' : 'stone_pickaxe'
  const pick = item(pickName)
  if (invCount([pick.id]) > 0) { progress('already has ' + pickName); return true }
  const need = what === 'woodpick'
    ? { planks: 3, sticks: 2, cobble: 0 }
    : { planks: 2, sticks: 2, cobble: 3 }
  if (need.cobble) {
    const cid = item('cobblestone').id
    if (invCount([cid]) < need.cobble) {
      throw new Error('need ' + need.cobble + ' cobble (gather cobble first)')
    }
  }
  await ensurePlanks(need.planks + need.sticks * 2)
  await ensureSticks(need.sticks)
  await ensurePlanks(need.planks)
  let table = await findCraftTable(4)
  if (!table) {
    if (invCount([item('crafting_table').id]) === 0) {
      await ensurePlanks(4)
      if (!(await craftOnce(item('crafting_table'), null))) throw new Error('cannot craft table')
    }
    table = await placeCraftTable()
  }
  if (!(await craftOnce(pick, table))) throw new Error('cannot craft ' + pickName)
  progress('crafted ' + pickName)
  return true
}

async function taskChunkmine (t, args) {
  const x0 = parseInt(args.x0, 10)
  const x1 = parseInt(args.x1, 10)
  const z0 = parseInt(args.z0, 10)
  const z1 = parseInt(args.z1, 10)
  const layers = Math.max(1, Math.min(64, parseInt(args.layers, 10) || 16))
  if (![x0, x1, z0, z1].every(Number.isFinite)) throw new Error('chunkmine needs slice box')
  if (x1 < x0 || z1 < z0) throw new Error('chunkmine: empty slice')
  const yTop = Math.floor(bot.entity.position.y)
  const yBot = yTop - layers + 1

  const probe = () => {
    for (let x = x0; x <= x1; x += 4) {
      for (let z = z0; z <= z1; z += 4) {
        if (!bot.blockAt(require('vec3')(x, yTop, z))) return false
      }
    }
    return true
  }
  const probeDeadline = Date.now() + 20000
  while (!cancelled() && Date.now() < probeDeadline) {
    if (probe()) break
    await sleep(500)
  }

  const targets = new Map()
  for (let x = x0; x <= x1; x++) {
    for (let z = z0; z <= z1; z++) {
      for (let y = yBot; y <= yTop; y++) {
        const pos = require('vec3')(x, y, z)
        const blk = bot.blockAt(pos)
        if (!blk || blk.boundingBox === 'empty') continue
        if (blk.name === 'air' || blk.name === 'cave_air') continue
        if (/bedrock|chest|sign|door|torch|lantern/.test(blk.name)) continue
        if (blk.hardness === -1) continue
        targets.set(x + ',' + y + ',' + z, pos)
      }
    }
  }
  const total = targets.size
  progress('slice ' + x0 + '..' + x1 + '/' + z0 + '..' + z1 + ': ' + total + ' blocks')
  const tries = new Map()
  let mined = 0
  let gaveUp = 0

  while (!cancelled() && targets.size) {
    const bp = bot.entity.position
    let bestKey = null
    let bestPos = null
    let bestD = Infinity
    for (const [key, pos] of targets) {
      const dx = pos.x - bp.x
      const dy = pos.y - bp.y
      const dz = pos.z - bp.z
      const d = dx * dx + dy * dy + dz * dz
      if (d < bestD) { bestD = d; bestKey = key; bestPos = pos }
    }
    if (!bestKey) break

    let reached = false
    bot.pathfinder.setMovements(makeMovements(bot))
    bot.pathfinder.goto(new goals.GoalNear(bestPos.x, bestPos.y, bestPos.z, 2.0)).catch(() => {})
    const until = Date.now() + 9000
    while (!cancelled() && Date.now() < until) {
      const p = bot.entity.position
      if (Math.hypot(p.x - bestPos.x, p.z - bestPos.z) <= 3 && Math.abs(p.y - bestPos.y) <= 3.5) {
        reached = true
        break
      }
      await sleep(300)
    }
    if (cancelled()) return
    const bump = () => {
      const n = (tries.get(bestKey) || 0) + 1
      tries.set(bestKey, n)
      if (n >= 3) { targets.delete(bestKey); gaveUp++ }
    }
    if (!reached) { bump(); continue }

    const blk = bot.blockAt(bestPos)
    if (!blk || blk.boundingBox === 'empty') { targets.delete(bestKey); continue }
    try {
      if (bot.tool) await bot.tool.equipForBlock(blk)
      await bot.dig(blk)
      targets.delete(bestKey)
      tries.delete(bestKey)
      mined++
      if (mined % 10 === 0) progress('mined ' + mined + '/' + total)
      await sleep(rnd(60, 220))
    } catch (e) {
      bump()
      await sleep(400)
    }
  }

  if (!total) { progress('slice already clear'); return true }
  if (mined === 0 && !cancelled()) throw new Error('mined 0/' + total + ' (unreachable?)')
  progress('slice done ' + mined + '/' + total + (gaveUp ? ' skipped ' + gaveUp : ''))
  return true
}

async function runTask (msg) {
  const kind = msg.kind
  const args = msg.args || {}
  stopTask()
  const t = { id: msg.id, cancelled: false }
  task = t

  await waitStart(msg.startAt)
  if (t.cancelled || task !== t) return
  if (!bot || !bot.entity) {
    send({ evt: 'task', id: t.id, state: 'failed', detail: 'not online' })
    if (task === t) task = null
    return
  }

  send({ evt: 'task', id: t.id, state: 'started', detail: kind })
  try {
    if (kind === 'goto') await taskGoto(t, args)
    else if (kind === 'wander') await taskWander(t, args)
    else if (kind === 'mine') await taskMine(t, args)
    else if (kind === 'follow') await taskFollow(t, args)
    else if (kind === 'move') await taskMove(t, args)
    else if (kind === 'look') await taskLook(t, args)
    else if (kind === 'jump') await taskJump(t, args)
    else if (kind === 'rclick') await taskRclick(t, args)
    else if (kind === 'lclick') await taskLclick(t, args)
    else if (kind === 'swing') await taskSwing(t, args)
    else if (kind === 'sneak') await taskHold(t, args, 'sneak')
    else if (kind === 'sprint') await taskHold(t, args, 'sprint')
    else if (kind === 'drop') await taskDrop(t, args)
    else if (kind === 'tpa') await taskTpa(args)
    else if (kind === 'tpaccept') await taskTpaccept(args)
    else if (kind === 'near') await taskNear(t, args)
    else if (kind === 'silent') await taskSilent(t, args)
    else if (kind === 'defy') await taskDefy(t, args)
    else if (kind === 'beat') await taskBeat(t, args)
    else if (kind === 'inv') await taskInv(t, args)
    else if (kind === 'gather') await taskGather(t, args)
    else if (kind === 'craft') await taskCraft(t, args)
    else if (kind === 'chunkmine') await taskChunkmine(t, args)
    else if (kind === 'stop') { stopTask(); releaseControls(); send({ evt: 'task', id: t.id, state: 'done', detail: 'stop' }); return }
    else throw new Error('unknown task ' + kind)

    if (!cancelled()) send({ evt: 'task', id: t.id, state: 'done', detail: kind })
  } catch (e) {
    if (!cancelled()) send({ evt: 'task', id: t.id, state: 'failed', detail: String(e.message || e) })
  } finally {
    if (task === t) task = null
  }
}

async function handle (msg) {
  switch (msg.cmd) {
    case 'join':
      doJoin(msg)
      break
    case 'leave':
      doLeave()
      // exit so the engine's stop() doesn't burn its 3s kill-timeout;
      // small delay lets the 'offline' status flush to stdout first
      setTimeout(() => { try { process.exit(0) } catch (e) {} }, 100)
      break
    case 'filter':
      chatFilter = !!msg.on
      break
    case 'chat': {
      if (!bot) break
      const delay = msg.human === false ? 0 : rnd(400, 1800)
      if (typeof msg.text === 'string' && msg.text.startsWith('/')) lastCmdAt = Date.now()
      setTimeout(() => {
        if (bot) try { bot.chat(msg.text) } catch (e) { send({ evt: 'log', msg: 'chat fail' }) }
      }, delay)
      break
    }
    case 'task':
      runTask(msg).catch(e => send({ evt: 'log', msg: 'task err: ' + e.message }))
      break
    case 'state':
      send({ evt: 'status', state: bot && bot.entity ? 'online' : 'offline', detail: bot ? bot.username : null })
      break
    default:
      send({ evt: 'log', msg: 'unknown cmd ' + msg.cmd })
  }
}

process.on('uncaughtException', (e) => send({ evt: 'log', msg: 'uncaught: ' + (e && e.message || e) }))
process.on('unhandledRejection', (e) => send({ evt: 'log', msg: 'rejection: ' + (e && e.message || e) }))

const rl = readline.createInterface({ input: process.stdin })
rl.on('line', (line) => {
  if (!line.trim()) return
  let msg
  try { msg = JSON.parse(line) } catch (e) { return }
  handle(msg)
})
rl.on('close', () => {
  doLeave()
  process.exit(0)
})

send({ evt: 'status', state: 'idle', detail: 'engine ready' })
