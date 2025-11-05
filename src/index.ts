import { makeTownsBot } from '@towns-protocol/bot'
import { Hono } from 'hono'
import { logger } from 'hono/logger'
import { parseEther, formatEther, zeroAddress } from 'viem'
import { execute } from 'viem/experimental/erc7821'
import { waitForTransactionReceipt } from 'viem/actions'
import { createCanvas } from '@napi-rs/canvas'
import { commands } from './commands'

const bot = await makeTownsBot(process.env.APP_PRIVATE_DATA!, process.env.JWT_SECRET!, {
    commands: [...commands] as { name: string; description: string }[],
}) 

// Game state types
type Player = {
    userId: string          // Towns user ID (for mentions)
    smartAccountAddress: string  // Smart account address (for tips/payouts)
    alive: boolean
    lastAction: 'shoot' | 'pass' | null
}

// Map to track user eligibility: smartAccountAddress -> { userId, channelId }
// This ensures we know which users have tipped and are eligible to play
const eligiblePlayers = new Map<string, { userId: string; channelId: string }>()

type GameState = {
    players: Player[]
    potBalance: bigint // in wei
    currentTurnIndex: number
    status: 'waiting' | 'active' | 'finished'
    winner: string | null
}

// In-memory game storage (channelId -> GameState)
const games = new Map<string, GameState>()

// Bot app contract address (holds pot balance)
const APP_CONTRACT_ADDRESS = '0xfB9FAA57889419B39ba12d8B53AedC9ac1Bf1Cce' as const

// Game amounts (configured for Base Sepolia testnet)
// Using smaller amounts for testnet - adjust as needed
const PASS_BURN = parseEther('0.0005') // 0.0005 ETH burn on pass
const GRIT_BONUS = parseEther('0.001') // +0.001 ETH on successful shoot

// Minimum tip to join (informational only - any amount accepted)
const MIN_TIP = parseEther('0.0001') // Minimum suggested tip

// Helper to get alive players
function getAlivePlayers(game: GameState): Player[] {
    return game.players.filter(p => p.alive)
}

// Helper to get current player
function getCurrentPlayer(game: GameState): Player | null {
    const alive = getAlivePlayers(game)
    if (alive.length === 0) return null
    const index = game.currentTurnIndex % alive.length
    return alive[index]
}

// Helper to find player index in alive players
function getAlivePlayerIndex(game: GameState, userId: string): number {
    const alive = getAlivePlayers(game)
    return alive.findIndex(p => p.userId === userId)
}

// Helper to format balance
function formatBalance(wei: bigint): string {
    return `$${formatEther(wei)}`
}

// Helper to check if everyone passed in a full rotation
function checkForcedShoot(game: GameState): boolean {
    const alive = getAlivePlayers(game)
    if (alive.length < 2) return false
    
    // Check if all alive players passed in this rotation
    const allPassed = alive.every(p => p.lastAction === 'pass')
    return allPassed
}

// Helper to advance turn
function advanceTurn(game: GameState) {
    const alive = getAlivePlayers(game)
    if (alive.length > 0) {
        game.currentTurnIndex = (game.currentTurnIndex + 1) % alive.length
    }
}

// Helper to check win condition
function checkWinCondition(game: GameState): string | null {
    const alive = getAlivePlayers(game)
    if (alive.length === 1) {
        return alive[0].userId
    }
    return null
}

// Helper to generate BANG image
async function generateBangImage(): Promise<Buffer> {
    const width = 400
    const height = 400
    const canvas = createCanvas(width, height)
    const ctx = canvas.getContext('2d')
    
    // Dark red/black background
    const gradient = ctx.createRadialGradient(200, 200, 0, 200, 200, 250)
    gradient.addColorStop(0, '#ff0000')
    gradient.addColorStop(0.5, '#8b0000')
    gradient.addColorStop(1, '#000000')
    ctx.fillStyle = gradient
    ctx.fillRect(0, 0, width, height)
    
    // Explosion effect (circles)
    ctx.fillStyle = '#ff6600'
    ctx.beginPath()
    ctx.arc(200, 200, 150, 0, Math.PI * 2)
    ctx.fill()
    
    ctx.fillStyle = '#ffaa00'
    ctx.beginPath()
    ctx.arc(200, 200, 100, 0, Math.PI * 2)
    ctx.fill()
    
    ctx.fillStyle = '#ffff00'
    ctx.beginPath()
    ctx.arc(200, 200, 50, 0, Math.PI * 2)
    ctx.fill()
    
    // BANG text
    ctx.fillStyle = '#ffffff'
    ctx.font = 'bold 60px Arial'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.strokeStyle = '#000000'
    ctx.lineWidth = 4
    ctx.strokeText('BANG!', 200, 200)
    ctx.fillText('BANG!', 200, 200)
    
    // Skull emoji style
    ctx.fillStyle = '#ffffff'
    ctx.font = 'bold 80px Arial'
    ctx.fillText('💀', 200, 300)
    
    return canvas.toBuffer('image/png')
}

// Helper to generate CLICK image
async function generateClickImage(): Promise<Buffer> {
    const width = 400
    const height = 400
    const canvas = createCanvas(width, height)
    const ctx = canvas.getContext('2d')
    
    // Green/blue gradient background (relief/safe)
    const gradient = ctx.createLinearGradient(0, 0, width, height)
    gradient.addColorStop(0, '#1a5f3f')
    gradient.addColorStop(0.5, '#2d8659')
    gradient.addColorStop(1, '#4a9b73')
    ctx.fillStyle = gradient
    ctx.fillRect(0, 0, width, height)
    
    // Safe circle in center
    ctx.strokeStyle = '#ffffff'
    ctx.lineWidth = 8
    ctx.beginPath()
    ctx.arc(200, 200, 120, 0, Math.PI * 2)
    ctx.stroke()
    
    // Inner circle
    ctx.strokeStyle = '#90ee90'
    ctx.lineWidth = 4
    ctx.beginPath()
    ctx.arc(200, 200, 100, 0, Math.PI * 2)
    ctx.stroke()
    
    // Checkmark
    ctx.strokeStyle = '#ffffff'
    ctx.lineWidth = 12
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.beginPath()
    ctx.moveTo(150, 200)
    ctx.lineTo(180, 230)
    ctx.lineTo(250, 160)
    ctx.stroke()
    
    // CLICK text
    ctx.fillStyle = '#ffffff'
    ctx.font = 'bold 50px Arial'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.strokeStyle = '#000000'
    ctx.lineWidth = 3
    ctx.strokeText('CLICK!', 200, 320)
    ctx.fillText('CLICK!', 200, 320)
    
    // Relieved emoji
    ctx.fillStyle = '#ffffff'
    ctx.font = 'bold 60px Arial'
    ctx.fillText('😅', 200, 100)
    
    return canvas.toBuffer('image/png')
}

// Helper to format game status
function formatGameStatus(game: GameState): string {
    const alive = getAlivePlayers(game)
    const currentPlayer = getCurrentPlayer(game)
    
    let status = `**🎰 Deadman's Tip Game**\n\n`
    status += `**Pot:** ${formatBalance(game.potBalance)}\n`
    status += `**Status:** ${game.status === 'waiting' ? '⏳ Waiting for players' : game.status === 'active' ? '🔥 Active' : '✅ Finished'}\n\n`
    
    if (game.status === 'active') {
        status += `**Alive Players:** ${alive.length}/${game.players.length}\n`
        status += `**Current Turn:** <@${currentPlayer?.userId}>\n\n`
    } else if (game.status === 'waiting') {
        status += `**Joined Players:** ${game.players.length}\n`
        status += `**Players:** ${game.players.map(p => `<@${p.userId}>`).join(', ')}\n\n`
    }
    
    if (game.winner) {
        status += `**🏆 Winner:** <@${game.winner}>\n`
        status += `**Winnings:** ${formatBalance(game.potBalance)}\n`
    }
    
    return status
}

// Handle tips as entry payments
bot.onTip(async (handler, event) => {
    // Only accept tips when receiver is the bot
    if (event.receiverAddress.toLowerCase() !== bot.botId.toLowerCase()) {
        return
    }
    
    const channelId = event.channelId
    let game = games.get(channelId)
    
    // If no game exists, create one
    if (!game) {
        game = {
            players: [],
            potBalance: 0n,
            currentTurnIndex: 0,
            status: 'waiting',
            winner: null,
        }
        games.set(channelId, game)
    }
    
    // Check if game is accepting new players
    if (game.status !== 'waiting') {
        await handler.sendMessage(
            channelId,
            `Game is already ${game.status}. Please wait for the next round.`
        )
        return
    }
    
    // Track this user as eligible (smart account -> Towns user ID mapping)
    const smartAccountAddress = event.senderAddress.toLowerCase()
    eligiblePlayers.set(smartAccountAddress, {
        userId: event.userId,
        channelId: channelId,
    })
    
    // Check if player already joined (by smart account address or userId)
    const existingPlayer = game.players.find(
        p => p.smartAccountAddress.toLowerCase() === smartAccountAddress || p.userId === event.userId
    )
    if (existingPlayer) {
        await handler.sendMessage(
            channelId,
            `<@${event.userId}> You're already in the game! Use \`/start-game\` when ready.`
        )
        return
    }
    
    // Accept any tip amount - add full amount to pot
    // Add player and update pot with full tip amount
    game.players.push({
        userId: event.userId,  // Towns user ID for mentions
        smartAccountAddress: event.senderAddress,  // Smart account for payouts
        alive: true,
        lastAction: null,
    })
    game.potBalance += event.amount
    
    const tipAmount = formatBalance(event.amount)
    
    // Mention the user so they know they're eligible
    await handler.sendMessage(
        channelId,
        `✅ <@${event.userId}> joined the game! ${tipAmount} tip received.\n\n` +
        `**Players:** ${game.players.length}\n` +
        `**Pot:** ${formatBalance(game.potBalance)}\n\n` +
        `Use \`/start-game\` to begin when ready!`
    )
})

// Join game command (alternative to tipping)
bot.onSlashCommand('join-game', async (handler, { channelId, userId }) => {
    await handler.sendMessage(
        channelId,
        `To join the game, tip me any amount using the Towns tipping feature.\n\n` +
        `**How to tip:**\n` +
        `1. Click the 💸 tip button on any of my messages\n` +
        `2. Enter any amount you'd like to contribute to the pot\n` +
        `3. Confirm the tip\n\n` +
        `Once you've tipped, you'll be added to the game!`
    )
})

// Start game command
bot.onSlashCommand('start-game', async (handler, { channelId, userId }) => {
    const game = games.get(channelId)
    
    if (!game) {
        await handler.sendMessage(channelId, 'No game in progress. Players need to join first by tipping the bot.')
        return
    }
    
    if (game.status !== 'waiting') {
        await handler.sendMessage(channelId, `Game is already ${game.status}!`)
        return
    }
    
    if (game.players.length < 2) {
        await handler.sendMessage(
            channelId,
            `Need at least 2 players to start. Currently ${game.players.length} player(s) joined.\n\n` +
            `Tip the bot any amount to join!`
        )
        return
    }
    
    // Start the game
    game.status = 'active'
    game.currentTurnIndex = 0
    const currentPlayer = getCurrentPlayer(game)!
    
    await handler.sendMessage(
        channelId,
        `🎰 **Game Started!**\n\n` +
        `${formatGameStatus(game)}\n` +
        `**Turn Order:** ${game.players.map((p, i) => `${i + 1}. <@${p.userId}>`).join(', ')}\n\n` +
        `<@${currentPlayer.userId}>, it's your turn! Choose \`/shoot\` or \`/pass\` 🔫`
    )
})

// Shoot command
bot.onSlashCommand('shoot', async (handler, { channelId, userId }) => {
    const game = games.get(channelId)
    
    if (!game || game.status !== 'active') {
        await handler.sendMessage(channelId, 'No active game. Use `/join-game` to start!')
        return
    }
    
    const currentPlayer = getCurrentPlayer(game)
    if (!currentPlayer) {
        await handler.sendMessage(channelId, 'Game error: No current player found.')
        return
    }
    
    if (currentPlayer.userId.toLowerCase() !== userId.toLowerCase()) {
        await handler.sendMessage(
            channelId,
            `Not your turn! It's <@${currentPlayer.userId}>'s turn.`
        )
        return
    }
    
    if (!currentPlayer.alive) {
        await handler.sendMessage(channelId, 'You are already eliminated!')
        return
    }
    
    // Spin the chamber (50/50 chance)
    const isDead = Math.random() < 0.5
    currentPlayer.lastAction = 'shoot'
    
    // Reset lastAction for all players after a shoot (new rotation starts)
    getAlivePlayers(game).forEach(p => p.lastAction = null)
    
    if (isDead) {
        // 💥 Bang! Player eliminated
        currentPlayer.alive = false
        const aliveCount = getAlivePlayers(game).length
        
        // Generate BANG image
        const bangImage = await generateBangImage()
        
        await handler.sendMessage(
            channelId,
            `💥 **BANG!** <@${userId}> pulled the trigger and... lost! 💀\n\n` +
            `**Remaining Players:** ${aliveCount}\n` +
            `**Pot:** ${formatBalance(game.potBalance)}\n\n` +
            `${aliveCount > 1 ? 'Game continues...' : ''}`,
            {
                attachments: [{
                    type: 'chunked',
                    data: new Uint8Array(bangImage),
                    filename: 'bang.png',
                    mimetype: 'image/png',
                }]
            }
        )
        
        // Check win condition
        const winner = checkWinCondition(game)
        if (winner) {
            game.status = 'finished'
            game.winner = winner
            await handler.sendMessage(
                channelId,
                `🏆 **GAME OVER!**\n\n` +
                `<@${winner}> is the last survivor and wins the pot of ${formatBalance(game.potBalance)}! 🎉\n\n` +
                `${formatGameStatus(game)}\n\n` +
                `Start a new game by having players tip the bot to join!`
            )
            // Reset game for next round
            games.delete(channelId)
            return
        }
        
        // Advance to next alive player
        advanceTurn(game)
        const nextPlayer = getCurrentPlayer(game)
        if (nextPlayer) {
            await handler.sendMessage(
                channelId,
                `<@${nextPlayer.userId}>, it's your turn! Choose \`/shoot\` or \`/pass\` 🔫`
            )
        }
    } else {
        // 🔫 Click! Player survives
        game.potBalance += GRIT_BONUS
        
        // Generate CLICK image
        const clickImage = await generateClickImage()
        
        await handler.sendMessage(
            channelId,
            `🔫 **CLICK!** <@${userId}> survived! 💪\n\n` +
            `**Grit Bonus:** +${formatBalance(GRIT_BONUS)} added to pot\n` +
            `**New Pot:** ${formatBalance(game.potBalance)}\n\n` +
            `Next player's turn...`,
            {
                attachments: [{
                    type: 'chunked',
                    data: new Uint8Array(clickImage),
                    filename: 'click.png',
                    mimetype: 'image/png',
                }]
            }
        )
        
        // Advance to next player
        advanceTurn(game)
        const nextPlayer = getCurrentPlayer(game)
        if (nextPlayer) {
            await handler.sendMessage(
                channelId,
                `<@${nextPlayer.userId}>, it's your turn! Choose \`/shoot\` or \`/pass\` 🔫`
            )
        }
    }
})

// Pass command
bot.onSlashCommand('pass', async (handler, { channelId, userId }) => {
    const game = games.get(channelId)
    
    if (!game || game.status !== 'active') {
        await handler.sendMessage(channelId, 'No active game. Use `/join-game` to start!')
        return
    }
    
    const currentPlayer = getCurrentPlayer(game)
    if (!currentPlayer) {
        await handler.sendMessage(channelId, 'Game error: No current player found.')
        return
    }
    
    if (currentPlayer.userId.toLowerCase() !== userId.toLowerCase()) {
        await handler.sendMessage(
            channelId,
            `Not your turn! It's <@${currentPlayer.userId}>'s turn.`
        )
        return
    }
    
    if (!currentPlayer.alive) {
        await handler.sendMessage(channelId, 'You are already eliminated!')
        return
    }
    
    // Check if this player is forced to shoot (everyone else passed)
    const alive = getAlivePlayers(game)
    const otherPlayers = alive.filter(p => p.userId !== userId)
    const allOthersPassed = otherPlayers.length > 0 && otherPlayers.every(p => p.lastAction === 'pass')
    
    if (allOthersPassed) {
        await handler.sendMessage(
            channelId,
            `⚠️ You cannot pass! Everyone else passed, so you must \`/shoot\`! 🔫`
        )
        return
    }
    
    // Burn from pot
    currentPlayer.lastAction = 'pass'
    const burnAmount = game.potBalance >= PASS_BURN ? PASS_BURN : game.potBalance
    game.potBalance -= burnAmount
    
    await handler.sendMessage(
        channelId,
        `😰 <@${userId}> passed. Pot burned by ${formatBalance(burnAmount)}.\n\n` +
        `**New Pot:** ${formatBalance(game.potBalance)}`
    )
    
    // Advance to next player first
    advanceTurn(game)
    
    // Check if everyone passed in a full rotation (forced shoot rule)
    // After advancing turn, check if all alive players just passed
    const allJustPassed = checkForcedShoot(game)
    
    const nextPlayer = getCurrentPlayer(game)
    if (nextPlayer) {
        if (allJustPassed) {
            // Reset all lastAction to allow new rotation
            getAlivePlayers(game).forEach(p => p.lastAction = null)
            await handler.sendMessage(
                channelId,
                `⚠️ **Everyone chickened out!** <@${nextPlayer.userId}> must pull the trigger! 🔫\n\n` +
                `No more passing allowed - you must \`/shoot\`!`
            )
        } else {
            await handler.sendMessage(
                channelId,
                `<@${nextPlayer.userId}>, it's your turn! Choose \`/shoot\` or \`/pass\` 🔫`
            )
        }
    }
})

// Game status command
bot.onSlashCommand('game-status', async (handler, { channelId }) => {
    const game = games.get(channelId)
    
    if (!game) {
        await handler.sendMessage(
            channelId,
            `No game in progress. Start a new game by having players tip the bot to join!`
        )
        return
    }
    
    await handler.sendMessage(channelId, formatGameStatus(game))
})

// Help command
bot.onSlashCommand('help', async (handler, { channelId }) => {
    await handler.sendMessage(
        channelId,
        '**🎰 Deadman\'s Tip - Help**\n\n' +
        '**How to Play:**\n' +
        `1. Tip the bot any amount to join the game\n` +
        '2. Use `/start-game` when 2+ players have joined\n' +
        '3. On your turn, choose `/shoot` or `/pass`\n' +
        '4. Last player standing wins the pot!\n\n' +
        '**Commands:**\n' +
        '• `/join-game` - Show how to join (tip the bot)\n' +
        '• `/start-game` - Start the game with current players\n' +
        '• `/shoot` - Pull the trigger (50/50 chance)\n' +
        '• `/pass` - Skip your turn (burns $0.50 from pot)\n' +
        '• `/game-status` - Check current game status\n\n' +
        '**Rules:**\n' +
        '• 💥 **Bang!** - You\'re eliminated, game continues\n' +
        '• 🔫 **Click!** - You survive, +$1 added to pot\n' +
        '• 😰 **Pass** - Burns $0.50 from pot\n' +
        '• ⚠️ If everyone passes in a rotation, next player is forced to shoot\n\n' +
        '**Good luck!** 🎲'
    )
})

const { jwtMiddleware, handler } = bot.start()

const app = new Hono()
app.use(logger())
app.post('/webhook', jwtMiddleware, handler)

export default app
