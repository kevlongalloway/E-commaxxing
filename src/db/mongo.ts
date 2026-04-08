import { randomUUID } from "crypto";
import type {
  Database,
  Product,
  CreateProductInput,
  UpdateProductInput,
  ProductQueryOptions,
  ProductVariant,
  CreateVariantInput,
  UpdateVariantInput,
} from "../types.js";

// Lazy-import mongodb to avoid bundling issues when using D1.
// The `mongodb` package works in Cloudflare Workers with `nodejs_compat_v2`.
type MongoClientType = import("mongodb").MongoClient;
type ProductCollectionType = import("mongodb").Collection<MongoProductDoc>;
type VariantCollectionType = import("mongodb").Collection<MongoVariantDoc>;

type MongoProductDoc = Omit<Product, "id"> & { _id: string };
type MongoVariantDoc = Omit<ProductVariant, "id"> & { _id: string };

let _client: MongoClientType | null = null;

async function getProductCollection(uri: string, dbName: string): Promise<ProductCollectionType> {
  if (!_client) {
    const { MongoClient } = await import("mongodb");
    _client = new MongoClient(uri, {
      serverSelectionTimeoutMS: 5000,
      connectTimeoutMS: 5000,
    });
    await _client.connect();
  }
  return _client.db(dbName).collection<MongoProductDoc>("products");
}

async function getVariantCollection(uri: string, dbName: string): Promise<VariantCollectionType> {
  if (!_client) {
    const { MongoClient } = await import("mongodb");
    _client = new MongoClient(uri, {
      serverSelectionTimeoutMS: 5000,
      connectTimeoutMS: 5000,
    });
    await _client.connect();
  }
  return _client.db(dbName).collection<MongoVariantDoc>("product_variants");
}

export class MongoDatabase implements Database {
  constructor(
    private readonly uri: string,
    private readonly dbName: string
  ) {}

  private async col(): Promise<ProductCollectionType> {
    return getProductCollection(this.uri, this.dbName);
  }

  private async varCol(): Promise<VariantCollectionType> {
    return getVariantCollection(this.uri, this.dbName);
  }

  async getProducts(options: ProductQueryOptions = {}): Promise<Product[]> {
    const { limit = 50, offset = 0, activeOnly = true } = options;
    const col = await this.col();

    const filter = activeOnly ? { active: true } : {};
    const docs = await col
      .find(filter)
      .sort({ created_at: -1 })
      .skip(offset)
      .limit(limit)
      .toArray();

    return docs.map(docToProduct);
  }

  async getProduct(id: string): Promise<Product | null> {
    const col = await this.col();
    const doc = await col.findOne({ _id: id });
    return doc ? docToProduct(doc) : null;
  }

  async createProduct(
    input: CreateProductInput,
    defaultCurrency: string
  ): Promise<Product> {
    const col = await this.col();
    const now = new Date().toISOString();

    const doc: MongoProductDoc = {
      _id: randomUUID(),
      name: input.name,
      description: input.description ?? "",
      price: input.price,
      currency: input.currency ?? defaultCurrency,
      images: input.images ?? [],
      metadata: input.metadata ?? {},
      stock: input.stock ?? -1,
      active: input.active ?? true,
      stripe_product_id: null,
      stripe_price_id: null,
      created_at: now,
      updated_at: now,
    };

    await col.insertOne(doc);
    return docToProduct(doc);
  }

  async updateProduct(
    id: string,
    input: UpdateProductInput
  ): Promise<Product | null> {
    const col = await this.col();
    const now = new Date().toISOString();

    const updateFields: Partial<MongoProductDoc> = {
      ...(input.name !== undefined && { name: input.name }),
      ...(input.description !== undefined && { description: input.description }),
      ...(input.price !== undefined && { price: input.price }),
      ...(input.currency !== undefined && { currency: input.currency }),
      ...(input.images !== undefined && { images: input.images }),
      ...(input.metadata !== undefined && { metadata: input.metadata }),
      ...(input.stock !== undefined && { stock: input.stock }),
      ...(input.active !== undefined && { active: input.active }),
      updated_at: now,
    };

    const result = await col.findOneAndUpdate(
      { _id: id },
      { $set: updateFields },
      { returnDocument: "after" }
    );

    return result ? docToProduct(result) : null;
  }

  async deleteProduct(id: string): Promise<boolean> {
    const col = await this.col();
    const result = await col.deleteOne({ _id: id });
    return result.deletedCount > 0;
  }

  async updateStripeIds(
    id: string,
    stripeProductId: string,
    stripePriceId: string
  ): Promise<void> {
    const col = await this.col();
    await col.updateOne(
      { _id: id },
      {
        $set: {
          stripe_product_id: stripeProductId,
          stripe_price_id: stripePriceId,
          updated_at: new Date().toISOString(),
        },
      }
    );
  }

  async getProductVariants(productId: string): Promise<ProductVariant[]> {
    const col = await this.varCol();
    const docs = await col
      .find({ product_id: productId })
      .sort({ created_at: 1 })
      .toArray();

    return docs.map(docToVariant);
  }

  async getProductVariant(id: string): Promise<ProductVariant | null> {
    const col = await this.varCol();
    const doc = await col.findOne({ _id: id });
    return doc ? docToVariant(doc) : null;
  }

  async createVariant(
    productId: string,
    input: CreateVariantInput
  ): Promise<ProductVariant> {
    const col = await this.varCol();
    const now = new Date().toISOString();

    const doc: MongoVariantDoc = {
      _id: randomUUID(),
      product_id: productId,
      size: input.size,
      color: input.color ?? null,
      sku: input.sku ?? null,
      stock: input.stock ?? -1,
      metadata: input.metadata ?? {},
      created_at: now,
      updated_at: now,
    };

    await col.insertOne(doc);
    return docToVariant(doc);
  }

  async updateVariant(
    id: string,
    input: UpdateVariantInput
  ): Promise<ProductVariant | null> {
    const col = await this.varCol();
    const now = new Date().toISOString();

    const updateFields: Partial<MongoVariantDoc> = {
      ...(input.size !== undefined && { size: input.size }),
      ...(input.color !== undefined && { color: input.color }),
      ...(input.sku !== undefined && { sku: input.sku }),
      ...(input.stock !== undefined && { stock: input.stock }),
      ...(input.metadata !== undefined && { metadata: input.metadata }),
      updated_at: now,
    };

    const result = await col.findOneAndUpdate(
      { _id: id },
      { $set: updateFields },
      { returnDocument: "after" }
    );

    return result ? docToVariant(result) : null;
  }

  async deleteVariant(id: string): Promise<boolean> {
    const col = await this.varCol();
    const result = await col.deleteOne({ _id: id });
    return result.deletedCount > 0;
  }
}

function docToProduct(doc: MongoProductDoc): Product {
  const { _id, ...rest } = doc;
  return { id: _id, ...rest };
}

function docToVariant(doc: MongoVariantDoc): ProductVariant {
  const { _id, ...rest } = doc;
  return { id: _id, ...rest };
}
