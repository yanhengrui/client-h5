import type { InventoryItem } from '../api/contract'

export type CropId = 'WHEAT' | 'CARROT' | 'TOMATO'

export type CropDefinition = {
  id: CropId
  itemId: string
  catalogKey: string
  name: string
  shortName: string
  icon: string
  seedPrice: number
  sellPrice: number
  growthMinutes: number
  harvestYield: number
  description: string
}

export const CROPS: readonly CropDefinition[] = [
  { id: 'WHEAT', itemId: '1', catalogKey: 'crop_WHEAT', name: '阳光小麦', shortName: '小麦', icon: '🌾', seedPrice: 10, sellPrice: 20, growthMinutes: 10, harvestYield: 5, description: '金黄饱满，是每座农场的第一份收获。' },
  { id: 'CARROT', itemId: '2', catalogKey: 'crop_CARROT', name: '脆甜胡萝卜', shortName: '胡萝卜', icon: '🥕', seedPrice: 20, sellPrice: 25, growthMinutes: 20, harvestYield: 6, description: '橙红的根茎藏在松软泥土里，清甜又爽脆。' },
  { id: 'TOMATO', itemId: '3', catalogKey: 'crop_TOMATO', name: '红宝石番茄', shortName: '番茄', icon: '🍅', seedPrice: 30, sellPrice: 30, growthMinutes: 30, harvestYield: 8, description: '藤蔓间挂满红亮果实，像夏日里的小灯笼。' },
]

const cropAliases = new Map<string, CropDefinition>()
for (const crop of CROPS) {
  cropAliases.set(crop.id, crop)
  cropAliases.set(crop.itemId, crop)
  cropAliases.set(crop.catalogKey.toUpperCase(), crop)
}

export function findCropDefinition(value?: string): CropDefinition | undefined {
  return cropAliases.get(String(value ?? '').toUpperCase())
}

export function cropDefinition(value?: string): CropDefinition {
  return findCropDefinition(value) ?? CROPS[0]
}

export function cropInventoryCount(items: InventoryItem[], itemType: 'SEED' | 'CROP', crop: CropDefinition) {
  return items
    .filter((item) => item.item_type.toUpperCase().includes(itemType) && item.item_id === crop.itemId)
    .reduce((sum, item) => sum + item.quantity, 0)
}

export const EMPTY_PLOT_ASSET = '/assets/crops/soil-empty.webp'

export function cropStageAsset(crop: CropDefinition, stage?: string) {
  const cropName = crop.id.toLowerCase()
  const growthStage = stage === 'MATURE'
    ? 'mature'
    : stage === 'SEMI_MATURE'
      ? 'growing'
      : 'seedling'
  return `/assets/crops/${cropName}-${growthStage}.webp`
}

export function cropMatureAsset(crop: CropDefinition) {
  return cropStageAsset(crop, 'MATURE')
}

export function cropSeedAsset(crop: CropDefinition) {
  return `/assets/seeds/${crop.id.toLowerCase()}-seeds.png`
}
