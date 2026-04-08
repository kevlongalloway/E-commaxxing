# Product Management & Sizing Guide

## Overview

E-commaxxing supports two types of products:

1. **Simple Products** - Single item with unified stock tracking (e.g., digital goods, books without variants)
2. **Variant Products** - Products with multiple sizes, colors, or options, each with separate inventory (e.g., clothing, shoes, t-shirts)

This guide explains how to manage products and variants through the admin API.

---

## Product Schema

### Product Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | UUID | Generated | Unique product identifier |
| `name` | String | Yes | Product name (max 255 chars) |
| `description` | String | No | Product description (max 5000 chars) |
| `price` | Integer | Yes | Price in smallest currency unit (e.g., cents). 1000 = $10.00 |
| `currency` | String | No | ISO currency code (default: "usd"). Must be 3 characters |
| `images` | String[] | No | Array of image URLs (max 8 per Stripe limitation) |
| `metadata` | Object | No | Custom JSON object for additional data |
| `stock` | Integer | No | Product-level stock count. -1 = unlimited (default: -1) |
| `active` | Boolean | No | Whether product is visible to customers (default: true) |
| `stripe_product_id` | String | Auto | Stripe product ID (auto-populated) |
| `stripe_price_id` | String | Auto | Stripe price ID (auto-populated) |
| `created_at` | ISO String | Auto | Creation timestamp |
| `updated_at` | ISO String | Auto | Last update timestamp |

### Creating a Simple Product

```bash
curl -X POST https://api.example.com/admin/products \
  -H "Authorization: Bearer YOUR_ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Coffee Mug",
    "description": "Ceramic coffee mug, 12 oz",
    "price": 1299,
    "currency": "usd",
    "stock": 50,
    "images": ["https://example.com/mug.jpg"],
    "metadata": {
      "category": "drinkware",
      "material": "ceramic"
    }
  }'
```

---

## Product Variants (Sizes, Colors, Options)

Variants allow you to track inventory **per size/color combination**. Each variant has:
- Its own stock count
- Optional SKU for your warehouse system
- Optional color identifier
- Custom metadata

### Variant Schema

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | UUID | Generated | Unique variant identifier |
| `product_id` | UUID | Generated | Parent product ID |
| `size` | String | Yes | Size designation (e.g., "Small", "Medium", "Large", "XL") |
| `color` | String | No | Color name (e.g., "Black", "Navy Blue") |
| `sku` | String | No | Stock keeping unit for inventory systems |
| `stock` | Integer | No | Variant stock count. -1 = unlimited (default: -1) |
| `metadata` | Object | No | Custom JSON object for variant-specific data |
| `created_at` | ISO String | Auto | Creation timestamp |
| `updated_at` | ISO String | Auto | Last update timestamp |

### Example: T-Shirt with Variants

**Step 1: Create the base product (no stock tracking)**

```bash
curl -X POST https://api.example.com/admin/products \
  -H "Authorization: Bearer YOUR_ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Classic T-Shirt",
    "description": "100% cotton unisex t-shirt",
    "price": 1999,
    "currency": "usd",
    "stock": -1,
    "images": ["https://example.com/tshirt.jpg"],
    "metadata": {
      "category": "apparel",
      "material": "cotton"
    }
  }'
```

Returns: `{ "id": "550e8400-e29b-41d4-a716-446655440000" }`

**Step 2: Create variants (one per size/color combo)**

```bash
# Small - Black variant
curl -X POST https://api.example.com/admin/products/550e8400-e29b-41d4-a716-446655440000/variants \
  -H "Authorization: Bearer YOUR_ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "size": "Small",
    "color": "Black",
    "sku": "TSHIRT-BLK-S",
    "stock": 15,
    "metadata": { "barcode": "123456789" }
  }'

# Small - Navy variant
curl -X POST https://api.example.com/admin/products/550e8400-e29b-41d4-a716-446655440000/variants \
  -H "Authorization: Bearer YOUR_ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "size": "Small",
    "color": "Navy",
    "sku": "TSHIRT-NVY-S",
    "stock": 8,
    "metadata": { "barcode": "987654321" }
  }'

# Medium - Black variant
curl -X POST https://api.example.com/admin/products/550e8400-e29b-41d4-a716-446655440000/variants \
  -H "Authorization: Bearer YOUR_ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "size": "Medium",
    "color": "Black",
    "sku": "TSHIRT-BLK-M",
    "stock": 20
  }'
```

---

## Stock Management

### Stock Conventions

Stock levels indicate availability status:

| Stock Value | Display | Meaning |
|-------------|---------|---------|
| `-1` | Unlimited | Stock not tracked for this variant |
| `0` | Out of Stock | Not available for purchase |
| `1-4` | Limited Stock | Show warning to customer |
| `5+` | In Stock | Fully available |

### Checking Variant Stock

```bash
curl https://api.example.com/products/550e8400-e29b-41d4-a716-446655440000/variants \
  -H "Authorization: Bearer YOUR_ADMIN_KEY"
```

Returns all variants with their current stock levels:

```json
{
  "ok": true,
  "data": [
    {
      "id": "var-001",
      "product_id": "550e8400-e29b-41d4-a716-446655440000",
      "size": "Small",
      "color": "Black",
      "sku": "TSHIRT-BLK-S",
      "stock": 15,
      "metadata": { "barcode": "123456789" },
      "created_at": "2025-02-15T10:30:00Z",
      "updated_at": "2025-02-15T10:30:00Z"
    },
    {
      "id": "var-002",
      "product_id": "550e8400-e29b-41d4-a716-446655440000",
      "size": "Small",
      "color": "Navy",
      "sku": "TSHIRT-NVY-S",
      "stock": 0,
      "metadata": { "barcode": "987654321" },
      "created_at": "2025-02-15T10:35:00Z",
      "updated_at": "2025-02-15T11:00:00Z"
    }
  ]
}
```

### Updating Stock

When an order is placed or inventory is adjusted:

```bash
curl -X PUT https://api.example.com/admin/products/550e8400-e29b-41d4-a716-446655440000/variants/var-001 \
  -H "Authorization: Bearer YOUR_ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "stock": 14 }'
```

---

## Customer Checkout with Variants

### Displaying Available Variants

Your frontend fetches variants from the public API:

```javascript
// Get product
const product = await fetch('/products/550e8400-e29b-41d4-a716-446655440000')
  .then(r => r.json());

// Get available variants (sizes, colors)
const variants = await fetch('/products/550e8400-e29b-41d4-a716-446655440000/variants')
  .then(r => r.json());

// Display size selector with stock status
variants.forEach(variant => {
  const status = variant.stock === 0 ? 'Out of Stock' : 
                 variant.stock === -1 ? 'In Stock' :
                 variant.stock < 5 ? 'Limited Stock' : 'In Stock';
  
  console.log(`${variant.size} - ${variant.color}: ${status} (${variant.stock})`);
});
```

### Adding to Cart with Size/Color

When customer selects a size and adds to cart, include size/color in cart item:

```javascript
const cartItems = [
  {
    productId: "550e8400-e29b-41d4-a716-446655440000",
    size: "Medium",
    color: "Black",
    quantity: 1
  },
  {
    productId: "550e8400-e29b-41d4-a716-446655440000",
    size: "Small",
    color: "Navy",
    quantity: 2
  }
];

// Checkout
const response = await fetch('/checkout/session', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    items: cartItems,
    successUrl: 'https://example.com/success?session_id={CHECKOUT_SESSION_ID}',
    cancelUrl: 'https://example.com/cart'
  })
});
```

### Checkout Error Handling

The API will return errors if:

1. **Size doesn't exist**: "Classic T-Shirt - Small (Pink) not found" (404)
2. **Out of stock**: "Insufficient stock for Classic T-Shirt - Medium (Black) (available: 0)" (400)
3. **Partial stock**: If only 2 Medium Black shirts available but customer orders 3, error: "Insufficient stock for Classic T-Shirt - Medium (Black) (available: 2)" (400)

---

## Size Chart Best Practices

### Standardized Size Names

Use consistent size names across all products:

**Apparel:**
- XS, S, M, L, XL, 2XL, 3XL (or Small, Medium, Large)
- For jeans: 28, 30, 32, 34, 36, 38, 40 (waist measurements)
- For shoes: 5.5, 6, 6.5, 7, 7.5, 8, 8.5, 9, 9.5, 10, etc.

**Colors:**
- Use common color names: Black, White, Navy, Red, Blue, Green, etc.
- Avoid ambiguous names like "Medium Blue" - use "Navy" or "Cobalt"

### Recommended Metadata Fields

Store additional variant info in metadata:

```json
{
  "size": "Large",
  "color": "Black",
  "metadata": {
    "fits_like": "true_to_size",
    "sleeve_length_cm": 82,
    "chest_width_cm": 56,
    "material_composition": "92% cotton, 8% elastane",
    "care_instructions": "Wash cold, dry low",
    "weight_grams": 180
  }
}
```

---

## Sold Out Handling

### Marking Items as Sold Out

Set stock to `0`:

```bash
curl -X PUT https://api.example.com/admin/products/550e8400-e29b-41d4-a716-446655440000/variants/var-002 \
  -H "Authorization: Bearer YOUR_ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "stock": 0 }'
```

### Customer Experience

When displaying variants:

```javascript
variants.forEach(v => {
  if (v.stock === 0) {
    console.log(`${v.size} - ${v.color}: SOLD OUT`);
    // Disable size option in UI
    disableSelectOption(v.size, v.color);
  } else {
    console.log(`${v.size} - ${v.color}: Available`);
  }
});
```

### Preventing Oversold Orders

The checkout API automatically prevents orders for out-of-stock sizes. No additional client-side validation needed, but it's good UX to prevent selection upfront.

---

## Admin API Endpoints

### Products

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/admin/products` | GET | List all products |
| `/admin/products` | POST | Create product |
| `/admin/products/:id` | GET | Get product by ID |
| `/admin/products/:id` | PUT | Update product |
| `/admin/products/:id` | DELETE | Delete product |

### Variants

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/admin/products/:productId/variants` | GET | List variants for product |
| `/admin/products/:productId/variants` | POST | Create variant |
| `/admin/products/:productId/variants/:variantId` | GET | Get variant by ID |
| `/admin/products/:productId/variants/:variantId` | PUT | Update variant |
| `/admin/products/:productId/variants/:variantId` | DELETE | Delete variant |

---

## API Responses

### Successful Variant Creation

```json
{
  "ok": true,
  "data": {
    "id": "var-123",
    "product_id": "prod-456",
    "size": "Medium",
    "color": "Black",
    "sku": "TSHIRT-BLK-M",
    "stock": 20,
    "metadata": {},
    "created_at": "2025-02-15T10:30:00Z",
    "updated_at": "2025-02-15T10:30:00Z"
  }
}
```

### Error: Variant Not Found

```json
{
  "ok": false,
  "error": "Variant not found"
}
```

### Error: Validation Failed

```json
{
  "ok": false,
  "error": "Validation failed",
  "details": {
    "fieldErrors": {
      "size": ["Required"]
    }
  }
}
```

---

## Summary

- **Simple products**: No variants, single stock level
- **Variant products**: Multiple size/color combos, each with own stock
- **Checkout**: Accepts optional `size` and `color` fields in line items
- **Stock handling**: -1 (unlimited), 0 (sold out), 1-4 (limited), 5+ (normal)
- **Sold out variants**: Return 404 if variant doesn't exist, 400 if stock insufficient
- **Display**: Frontend fetches variants and shows availability per size/color
