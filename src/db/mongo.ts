import { randomUUID } from "crypto";
import type {
  Database,
  Product,
  CreateProductInput,
  UpdateProductInput,
  ProductQueryOptions,
  User,
  UserWithHash,
  CreateUserInput,
} from "../types.js";
import { hashPassword } from "../lib/password.js";

// Lazy-import mongodb to avoid bundling issues when using D1.
// The `mongodb` package works in Cloudflare Workers with `nodejs_compat_v2`.
type MongoClientType = import("mongodb").MongoClient;
type CollectionType = import("mongodb").Collection<MongoProductDoc>;
type UserCollectionType = import("mongodb").Collection<MongoUserDoc>;

type MongoProductDoc = Omit<Product, "id"> & { _id: string };
type MongoUserDoc = Omit<UserWithHash, "id"> & { _id: string };

let _client: MongoClientType | null = null;

async function getClient(uri: string): Promise<MongoClientType> {
  if (!_client) {
    const { MongoClient } = await import("mongodb");
    _client = new MongoClient(uri, {
      serverSelectionTimeoutMS: 5000,
      connectTimeoutMS: 5000,
    });
    await _client.connect();
  }
  return _client;
}

async function getCollection(uri: string, dbName: string): Promise<CollectionType> {
  const client = await getClient(uri);
  return client.db(dbName).collection<MongoProductDoc>("products");
}

async function getUserCollection(uri: string, dbName: string): Promise<UserCollectionType> {
  const client = await getClient(uri);
  return client.db(dbName).collection<MongoUserDoc>("users");
}

export class MongoDatabase implements Database {
  constructor(
    private readonly uri: string,
    private readonly dbName: string
  ) {}

  private async col(): Promise<CollectionType> {
    return getCollection(this.uri, this.dbName);
  }

  private async userCol(): Promise<UserCollectionType> {
    return getUserCollection(this.uri, this.dbName);
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

  async createUser(input: CreateUserInput): Promise<User> {
    const col = await this.userCol();
    const id = randomUUID();
    const now = new Date().toISOString();
    const password_hash = await hashPassword(input.password);
    const email = input.email.toLowerCase();

    await col.insertOne({ _id: id, email, password_hash, created_at: now, updated_at: now });
    return { id, email, created_at: now, updated_at: now };
  }

  async getUserByEmail(email: string): Promise<UserWithHash | null> {
    const col = await this.userCol();
    const doc = await col.findOne({ email: email.toLowerCase() });
    if (!doc) return null;
    const { _id, ...rest } = doc;
    return { id: _id, ...rest };
  }

  async getUserById(id: string): Promise<User | null> {
    const col = await this.userCol();
    const doc = await col.findOne({ _id: id });
    if (!doc) return null;
    const { _id, password_hash: _, ...rest } = doc;
    return { id: _id, ...rest };
  }
}

function docToProduct(doc: MongoProductDoc): Product {
  const { _id, ...rest } = doc;
  return { id: _id, ...rest };
}
