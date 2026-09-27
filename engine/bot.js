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
      if (b.controlState.forward) {
        b.setControlState('forward', false)
        await sleep(rnd(200, 700))
        b.setControlState('forward', true)
      }
      if (Math.random() < 0.55) {
        const yaw = b.entity.yaw + rnd(-0.7, 0.7)
        const pitch = b.entity.pitch + rnd(-0.25, 0.25)
        try { await b.look(yaw, pitch, false) } catch (e) {}
      }
    }
  }
  loop().catch(() => {})
}

function makeMovements (b) {
  const m = new Movements(b)
  m.canDig = true
  m.allowSprinting = Math.random() < 0.6
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

  b.on('chat', (username, message) => {
    if (username === b.username) return
    send({ evt: 'chat', from: username, message })
  })

  b.on('messagestr', (message, position, jsonMsg) => {
    if (position !== 0) return
    send({ evt: 'say', message })
  })
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

  const pos = entity ? entity.position : require('vec3')(args.x, args.y, args.z)
  const range = args.range ?? 2
  const goal = new goals.GoalNear(pos.x, pos.y, pos.z, range)
  bot.pathfinder.setMovements(makeMovements(bot))
  bot.pathfinder.goto(goal)
  progress('walking to target')

  while (!cancelled()) {
    await sleep(400)
    const p = bot.entity.position
    if (Math.hypot(p.x - pos.x, p.z - pos.z) <= range + 0.5 && Math.abs(p.y - pos.y) < 2) break
    if (Date.now() > deadline) throw new Error('goto timeout')
    if (entity) {
      const g = new goals.GoalNear(entity.position.x, entity.position.y, entity.position.z, range)
      bot.pathfinder.goto(g).catch(() => {})
    }
  }
}

async function taskWander (t, args) {
  const radius = args.radius ?? 24
  const pauses = args.pauses !== false
  progress('wander started r=' + radius)

  while (!cancelled()) {
    const c = bot.entity.position
    const ang = rnd(0, Math.PI * 2)
    const dist = rnd(radius * 0.3, radius)
    const x = Math.floor(c.x + Math.cos(ang) * dist)
    const z = Math.floor(c.z + Math.sin(ang) * dist)
    const y = c.y
    bot.pathfinder.setMovements(makeMovements(bot))
    bot.pathfinder.goto(new goals.GoalXZ(x, z)).catch(() => {})
    while (!cancelled()) {
      await sleep(500)
      const p = bot.entity.position
      if (Math.hypot(p.x - x, p.z - z) < 2) break
      if (bot.pathfinder.isComputing()) continue
      break
    }
    if (cancelled()) return
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

  for (let dy = 0; dy < layers; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dz = -radius; dz <= radius; dz++) {
        const pos = require('vec3')(c.x + dx, c.y + dy, c.z + dz)
        const blk = bot.blockAt(pos)
        if (!blk || blk.boundingBox === 'empty') continue
        if (blk.name === 'air' || blk.name === 'cave_air') continue
        if (/bedrock|chest|sign|door|torch|lantern/.test(blk.name)) continue
        if (blk.hardness === -1) continue
        targets.push({ pos, dist: dx * dx + dz * dz + dy * dy })
      }
    }
  }
  targets.sort((a, b) => a.dist - b.dist)
  progress('mining ' + targets.length + ' blocks')

  let mined = 0
  for (const t2 of targets) {
    if (cancelled()) return
    const blk = bot.blockAt(t2.pos)
    if (!blk) continue
    try {
      if (bot.tool) await bot.tool.setBestTool(blk)
      await bot.dig(blk)
      mined++
      if (mined % 5 === 0) progress('mined ' + mined + '/' + targets.length)
      await sleep(rnd(80, 350))
    } catch (e) {}
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
  progress('moving ' + dir + ' ' + blocks + 'b')
  await sleep(rnd(120, 450))
  if (cancelled()) return
  const start = bot.entity.position.clone()
  releaseControls()
  bot.setControlState(dir, true)
  if (dir === 'forward' && Math.random() < 0.35) bot.setControlState('sprint', true)
  const timeout = Date.now() + blocks * 2600 + 1800
  while (!cancelled() && Date.now() < timeout) {
    const p = bot.entity.position
    const dx = p.x - start.x
    const dz = p.z - start.z
    const dist = Math.sqrt(dx * dx + dz * dz)
    if (dist >= blocks - 0.35 && Math.abs(p.y - start.y) < 1.6) break
    await sleep(60)
  }
  releaseControls()
  progress('moved ' + blocks + 'b')
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

async function taskRclick (t) {
  await sleep(rnd(80, 320))
  if (cancelled()) return
  let acted = false
  try {
    const blk = bot.blockAtCursor ? bot.blockAtCursor(4.5) : null
    if (blk) {
      bot.swingArm('right')
      await bot.activateBlock(blk)
      acted = true
    }
  } catch (e) {}
  if (!acted) {
    try { await bot.useEquippedItem() } catch (e) {}
    bot.swingArm('right')
  }
  await sleep(rnd(150, 400))
}

async function taskLclick (t) {
  await sleep(rnd(80, 320))
  if (cancelled()) return
  const target = bot.entityAtCursor ? bot.entityAtCursor() : null
  if (target && target !== bot.entity) {
    bot.swingArm('right')
    try { bot.attack(target) } catch (e) {}
    await sleep(rnd(350, 700))
    return
  }
  try {
    const blk = bot.blockAtCursor ? bot.blockAtCursor(4.5) : null
    if (blk) {
      progress('digging')
      if (bot.tool) await bot.tool.setBestTool(blk)
      bot.swingArm('right')
      await bot.dig(blk)
      progress('dug')
      return
    }
  } catch (e) {}
  bot.swingArm('right')
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
      if (blk && bot.tool) await bot.tool.setBestTool(blk)
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
      if (bot.tool) await bot.tool.setBestTool(blk)
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
      break
    case 'chat': {
      if (!bot) break
      const delay = msg.human === false ? 0 : rnd(400, 1800)
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
