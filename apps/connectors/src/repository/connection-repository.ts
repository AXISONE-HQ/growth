/**
 * ChannelConnection Repository — Prisma persistence layer
 * Resolves: KAN-477, KAN-558
 */
import { PrismaClient, ChannelType, ConnectionStatus, Prisma } from '@prisma/client';

const prisma = new PrismaClient();

export interface UpsertConnectionInput {
  tenantId: string;
  channelType: ChannelType;
  provider: string;
  providerAccountId: string;
  status: ConnectionStatus;
  label?: string;
  metadata?: Prisma.InputJsonValue;
  complianceStatus?: Prisma.InputJsonValue;
}

export async function upsertConnection(input: UpsertConnectionInput) {
  const now = new Date();
  return prisma.channelConnection.upsert({
    where: {
      tenantId_channelType_providerAccountId: {
        tenantId: input.tenantId,
        channelType: input.channelType,
        providerAccountId: input.providerAccountId,
      },
    },
    create: {
      tenantId: input.tenantId,
      channelType: input.channelType,
      provider: input.provider,
      providerAccountId: input.providerAccountId,
      status: input.status,
      label: input.label ?? null,
      metadata: input.metadata ?? {},
      complianceStatus: input.complianceStatus ?? null,
      connectedAt: now,
    },
    update: {
      status: input.status,
      label: input.label,
      metadata: input.metadata,
      complianceStatus: input.complianceStatus,
      updatedAt: now,
    },
  });
}

export async function revokeConnection(
  tenantId: string,
  channelType: ChannelType,
  providerAccountId: string
) {
  try {
    return await prisma.channelConnection.update({
      where: {
        tenantId_channelType_providerAccountId: { tenantId, channelType, providerAccountId },
      },
      data: { status: 'REVOKED', updatedAt: new Date() },
    });
  } catch {
    return null;
  }
}

export async function updateHealthCheck(
  tenantId: string,
  channelType: ChannelType,
  providerAccountId: string,
  healthStatus: string
) {
  await prisma.channelConnection.updateMany({
    where: { tenantId, channelType, providerAccountId },
    data: { lastHealthCheck: new Date(), healthStatus, updatedAt: new Date() },
  });
}

export async function getConnections(tenantId: string, channelType?: ChannelType) {
  return prisma.channelConnection.findMany({
    where: {
      tenantId,
      ...(channelType ? { channelType } : {}),
      status: { in: ['ACTIVE', 'PENDING'] },
    },
    orderBy: { createdAt: 'desc' },
  });
}

export async function getConnection(
  tenantId: string,
  channelType: ChannelType,
  providerAccountId: string
) {
  return prisma.channelConnection.findUnique({
    where: {
      tenantId_channelType_providerAccountId: { tenantId, channelType, providerAccountId },
    },
  });
}

export { prisma, ChannelType, ConnectionStatus };
