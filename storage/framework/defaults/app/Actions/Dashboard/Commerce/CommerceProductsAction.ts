import { Action } from '@stacksjs/actions'
import { config } from '@stacksjs/config'
import { Category, Manufacturer, Product, ProductUnit, ProductVariant, Review } from '@stacksjs/orm'
import {
  countProductRelations,
  normalizeCommerceProductRecord,
  normalizeManufacturerOption,
  normalizeProductOption,
  summarizeCommerceProducts,
} from './commerce-product-records'

export default new Action({
  name: 'CommerceProductsAction',
  description: 'Returns persisted Product records with native relationship context for dashboard management.',
  method: 'GET',
  apiResponse: true,

  async handle() {
    const products = await Product.orderByDesc('id').limit(500).get()
    const productIds = products.map(product => Number(product.get('id'))).filter(id => Number.isFinite(id) && id > 0)
    const [categories, manufacturers, variants, units, reviews] = await Promise.all([
      Category.orderBy('name', 'asc').limit(500).get(),
      Manufacturer.orderBy('manufacturer', 'asc').limit(500).get(),
      productIds.length > 0 ? ProductVariant.where('product_id', 'in', productIds).get() : [],
      productIds.length > 0 ? ProductUnit.where('product_id', 'in', productIds).get() : [],
      productIds.length > 0 ? Review.where('product_id', 'in', productIds).get() : [],
    ])
    const categoryMap = new Map(categories.map(category => [String(category.get('id') || ''), String(category.get('name') || '')]))
    const manufacturerMap = new Map(manufacturers.map(manufacturer => [String(manufacturer.get('id') || ''), String(manufacturer.get('manufacturer') || '')]))
    const variantCounts = countProductRelations(variants)
    const unitCounts = countProductRelations(units)
    const reviewCounts = countProductRelations(reviews)
    const records = products.map(product => normalizeCommerceProductRecord(
      product,
      categoryMap,
      manufacturerMap,
      variantCounts,
      unitCounts,
      reviewCounts,
    ))

    return {
      records,
      summary: summarizeCommerceProducts(records),
      categories: categories.map(normalizeProductOption),
      manufacturers: manufacturers.map(normalizeManufacturerOption),
      defaultCurrency: String((config as any).commerce?.currency || 'USD').toUpperCase(),
    }
  },
})
