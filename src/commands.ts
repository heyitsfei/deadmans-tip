import type { PlainMessage, SlashCommand } from '@towns-protocol/proto'

const commands = [
    {
        name: 'help',
        description: 'Get help with bot commands',
    },
    {
        name: 'join-game',
        description: 'Join the Deadman\'s Tip game (tip $1 to enter)',
    },
    {
        name: 'start-game',
        description: 'Start the game with current players',
    },
    {
        name: 'shoot',
        description: 'Pull the trigger (your turn)',
    },
    {
        name: 'pass',
        description: 'Pass your turn (burns $0.50 from pot)',
    },
    {
        name: 'game-status',
        description: 'Check current game status',
    },
] as const satisfies PlainMessage<SlashCommand>[]

export default commands
