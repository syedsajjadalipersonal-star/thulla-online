/**
 * Cards are integers 0..51.
 *   suit = floor(card / 13): 0 spades, 1 hearts, 2 diamonds, 3 clubs
 *   rank = card % 13 + 2:    2..10, 11 jack, 12 queen, 13 king, 14 ace
 *
 * This file must stay ES5-safe: it runs inside Nakama's JavaScript runtime.
 */
export type Card = number;

export const SUIT_SPADES = 0;
export const SUIT_HEARTS = 1;
export const SUIT_DIAMONDS = 2;
export const SUIT_CLUBS = 3;

/** The ace of spades, which opens every game of Thulla. */
export const ACE_OF_SPADES: Card = 12;

export function suitOf(card: Card): number {
  return Math.floor(card / 13);
}

export function rankOf(card: Card): number {
  return (card % 13) + 2;
}

export function makeCard(suit: number, rank: number): Card {
  return suit * 13 + (rank - 2);
}

const SUIT_NAMES = ['spades', 'hearts', 'diamonds', 'clubs'];
const SUIT_SYMBOLS = ['♠', '♥', '♦', '♣'];
const RANK_NAMES: { [rank: number]: string } = { 11: 'Jack', 12: 'Queen', 13: 'King', 14: 'Ace' };
const RANK_SHORT: { [rank: number]: string } = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };

export function suitName(suit: number): string {
  return SUIT_NAMES[suit];
}

/** "Queen of hearts" */
export function cardName(card: Card): string {
  const r = rankOf(card);
  return (RANK_NAMES[r] || String(r)) + ' of ' + SUIT_NAMES[suitOf(card)];
}

/** "Q♥" */
export function cardShort(card: Card): string {
  const r = rankOf(card);
  return (RANK_SHORT[r] || String(r)) + SUIT_SYMBOLS[suitOf(card)];
}

export function isCard(value: unknown): value is Card {
  return typeof value === 'number' && value >= 0 && value < 52 && Math.floor(value) === value;
}
