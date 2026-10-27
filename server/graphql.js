const {
  encodeRelayId,
  decodeRelayId,
  encodeRelayConnId,
  decodeRelayConnId
} = require('../shared/ot');
const db = require('./db');
const {
  setSessionCookies,
  getOrCreateSession,
  signJwt,
  verifyJwt
} = require('./auth');

// ============================================================================
// Relay Node Serializers
// ============================================================================
function formatSubscriptionPlanConnection(rawUserId) {
  const plans = db.getUserSubscriptionPlans(rawUserId);
  const edges = plans.map((p, idx) => ({
    node: {
      id: encodeRelayId('SubscriptionPlan', p.id),
      rawId: p.id,
      planId: p.planId,
      isActive: Boolean(p.isActive),
      createdAt: p.createdAt,
      __typename: 'SubscriptionPlan'
    },
    cursor: encodeRelayConnId(idx)
  }));
  return {
    edges,
    pageInfo: {
      endCursor: edges.length ? edges[edges.length - 1].cursor : null,
      hasNextPage: false
    }
  };
}

function formatMeNode(user) {
  if (!user) return null;
  return {
    id: encodeRelayId('Me', user.id),
    rawId: user.id,
    anonymous: Boolean(user.anonymous),
    name: user.name || null,
    email: user.email || null,
    companyImage: user.companyImage || null,
    migratedAt: user.migratedAt || null,
    settings: {
      theme: (user.settings && user.settings.theme) || 'eclipse',
      keymap: (user.settings && user.settings.keymap) || 'sublime'
    },
    defaultCodeshareSettings: {
      modeName:
        (user.defaultCodeshareSettings && user.defaultCodeshareSettings.modeName) ||
        'Plain Text',
      tabSize:
        (user.defaultCodeshareSettings && user.defaultCodeshareSettings.tabSize) ||
        '2'
    },
    subscriptionPlans: formatSubscriptionPlanConnection(user.id),
    isPro: db.isProSubscriber(user.id),
    __typename: 'Me'
  };
}

function formatUserNode(user) {
  if (!user) {
    return {
      id: encodeRelayId('User', 'anon:unknown'),
      anonymous: true,
      name: null,
      email: null,
      companyImage: null,
      subscriptionPlans: { edges: [], pageInfo: { endCursor: null, hasNextPage: false } },
      __typename: 'User'
    };
  }
  return {
    id: encodeRelayId('User', user.id),
    rawId: user.id,
    anonymous: Boolean(user.anonymous),
    name: user.name || null,
    email: user.email || null,
    companyImage: user.companyImage || null,
    subscriptionPlans: formatSubscriptionPlanConnection(user.id),
    isPro: db.isProSubscriber(user.id),
    __typename: 'User'
  };
}

function formatCodeHistoryEdge(record, cursorIndex, viewerRawUserId) {
  const creator = db.getUserByRawId(record.createdByUserId);
  return {
    node: {
      id: encodeRelayId('CodeHistory', record.id),
      historyId: record.historyId,
      index: record.index,
      value: record.value,
      createdAt: record.createdAt,
      createdBy: {
        me: record.createdByUserId === viewerRawUserId,
        userId: encodeRelayId('User', record.createdByUserId),
        rawUserId: record.createdByUserId,
        user: formatUserNode(creator),
        clientId: record.clientId || null
      },
      __typename: 'CodeHistory'
    },
    cursor: encodeRelayConnId(typeof cursorIndex === 'number' ? cursorIndex : record.index)
  };
}

function formatCodeshareUserEdge(record, cursorIndex, viewerRawUserId) {
  const user = db.getUserByRawId(record.createdByUserId);
  return {
    node: {
      id: encodeRelayId('CodeshareUser', record.id),
      createdAt: record.createdAt,
      modifiedAt: record.modifiedAt,
      color: record.color,
      cursor: {
        position: record.cursor ? record.cursor.position : -1,
        selectionEnd: record.cursor ? record.cursor.selectionEnd : -1
      },
      createdBy: {
        me: record.createdByUserId === viewerRawUserId,
        userId: encodeRelayId('User', record.createdByUserId),
        rawUserId: record.createdByUserId,
        name: (user && user.name) || null
      },
      __typename: 'CodeshareUser'
    },
    cursor: encodeRelayConnId(cursorIndex)
  };
}

function formatCodeshareNode(cs, viewerRawUserId, options = {}) {
  if (!cs) return null;
  const creator = db.getUserByRawId(cs.createdByUserId);
  const allHistory = db.getCodeHistories(cs.id);

  // Determine checkpoint and starting index for codeHistory connection
  let codeCheckpoint = null;
  let historyStartIndex = 0;

  if (cs.codeCheckpoint && cs.codeCheckpoint.codeHistoryId && cs.codeCheckpoint.value) {
    let rawTargetId = cs.codeCheckpoint.codeHistoryId;
    try {
      rawTargetId = decodeRelayId('CodeHistory', rawTargetId);
    } catch (_) {}
    const cpIdx = allHistory.findIndex((h) => h.id === rawTargetId);
    if (cpIdx !== -1) {
      const cpRecord = allHistory[cpIdx];
      codeCheckpoint = {
        codeHistoryId: encodeRelayId('CodeHistory', cpRecord.id),
        value: cs.codeCheckpoint.value,
        codeHistoryEdge: formatCodeHistoryEdge(cpRecord, cpRecord.index, viewerRawUserId)
      };
      historyStartIndex = cpIdx + 1;
    }
  }

  // Apply explicit `after` cursor if provided
  if (options.codeHistoryAfter) {
    try {
      const afterIdx = decodeRelayConnId(options.codeHistoryAfter);
      if (!isNaN(afterIdx)) {
        historyStartIndex = afterIdx + 1;
      }
    } catch (_) {}
  }

  const firstLimit = typeof options.codeHistoryFirst === 'number' ? options.codeHistoryFirst : 1000;
  const slicedHistory = allHistory.slice(historyStartIndex, historyStartIndex + firstLimit);
  const codeHistoryEdges = slicedHistory.map((rec) =>
    formatCodeHistoryEdge(rec, rec.index, viewerRawUserId)
  );
  const hasMoreHistory = historyStartIndex + firstLimit < allHistory.length;

  // Format active CodeshareUsers
  const activeUsers = db.getActiveCodeshareUsers(cs.id);
  const userEdges = activeUsers.map((uRec, idx) =>
    formatCodeshareUserEdge(uRec, idx, viewerRawUserId)
  );

  // Format canEdit
  const canEditMe = db.canUserEditCodeshare(cs, viewerRawUserId);
  const canEditUserIds = Array.isArray(cs.canEditUserIds)
    ? cs.canEditUserIds.map((uid) => encodeRelayId('User', uid))
    : null;

  return {
    id: encodeRelayId('Codeshare', cs.id),
    shortId: cs.id,
    slug: cs.slug || cs.id,
    title: cs.title || cs.id,
    modeName: cs.modeName || 'Plain Text',
    tabSize: String(cs.tabSize || '2'),
    saved: Boolean(cs.saved),
    migratedAt: cs.migratedAt || null,
    createdAt: cs.createdAt,
    updatedAt: cs.updatedAt || cs.createdAt,
    createdBy: {
      me: cs.createdByUserId === viewerRawUserId,
      userId: encodeRelayId('User', cs.createdByUserId),
      rawUserId: cs.createdByUserId,
      user: formatUserNode(creator)
    },
    modifiedBy: {
      me: cs.modifiedByUserId === viewerRawUserId,
      userId: encodeRelayId('User', cs.modifiedByUserId)
    },
    canEdit: {
      me: canEditMe,
      userIds: canEditUserIds
    },
    codeCheckpoint,
    codeHistory: {
      edges: codeHistoryEdges,
      pageInfo: {
        endCursor: codeHistoryEdges.length
          ? codeHistoryEdges[codeHistoryEdges.length - 1].cursor
          : codeCheckpoint
          ? codeCheckpoint.codeHistoryEdge.cursor
          : null,
        hasNextPage: hasMoreHistory
      }
    },
    users: {
      edges: userEdges,
      pageInfo: {
        endCursor: userEdges.length ? userEdges[userEdges.length - 1].cursor : null,
        hasNextPage: false
      }
    },
    __typename: 'Codeshare'
  };
}

function decodeShortCodeshareId(relayOrShortId) {
  if (!relayOrShortId) return null;
  try {
    return decodeRelayId('Codeshare', relayOrShortId);
  } catch (_) {
    return String(relayOrShortId).replace(/^Codeshare:/, '');
  }
}

// ============================================================================
// Real-Time Subscription PubSub Broker
// ============================================================================
class PubSubBroker {
  constructor() {
    // Set of { ws, subId, channel, shortId, userId }
    this.subscribers = new Set();
  }

  subscribe(sub) {
    this.subscribers.add(sub);
    return () => {
      this.subscribers.delete(sub);
    };
  }

  unsubscribeAllForSocket(ws) {
    const removedRooms = new Set();
    for (const sub of Array.from(this.subscribers)) {
      if (sub.ws === ws) {
        if (sub.shortId && sub.userId) {
          removedRooms.add(`${sub.shortId}:::${sub.userId}`);
        }
        this.subscribers.delete(sub);
      }
    }
    return Array.from(removedRooms).map((pair) => {
      const [shortId, userId] = pair.split(':::');
      return { shortId, userId };
    });
  }

  unsubscribeById(ws, subId) {
    for (const sub of Array.from(this.subscribers)) {
      if (sub.ws === ws && sub.subId === subId) {
        this.subscribers.delete(sub);
      }
    }
  }

  publishCodeHistoryCreated(shortId, historyRecord) {
    for (const sub of this.subscribers) {
      if (sub.channel === 'codeHistoryCreations' && sub.shortId === shortId) {
        const edge = formatCodeHistoryEdge(
          historyRecord,
          historyRecord.index,
          sub.userId
        );
        this.sendData(sub.ws, sub.subId, {
          codeHistoryCreations: {
            newCodeHistoryEdge: edge
          }
        });
      }
    }
  }

  publishCodeshareUserUpserted(shortId, userRecord) {
    const activeUsers = db.getActiveCodeshareUsers(shortId);
    const idx = Math.max(
      0,
      activeUsers.findIndex((u) => u.id === userRecord.id)
    );
    for (const sub of this.subscribers) {
      if (sub.channel === 'codeshareUserUpsertions' && sub.shortId === shortId) {
        const edge = formatCodeshareUserEdge(userRecord, idx, sub.userId);
        this.sendData(sub.ws, sub.subId, {
          codeshareUserUpsertions: {
            codeshareUserEdge: edge
          }
        });
      }
    }
  }

  publishCodeshareUserDeleted(shortId, deletedRecord) {
    if (!deletedRecord) return;
    const deletedId = encodeRelayId('CodeshareUser', deletedRecord.id);
    for (const sub of this.subscribers) {
      if (sub.channel === 'codeshareUserDeletions' && sub.shortId === shortId) {
        this.sendData(sub.ws, sub.subId, {
          codeshareUserDeletions: {
            deletedCodeshareUserId: deletedId
          }
        });
      }
    }
  }

  publishCodeshareUpdated(shortId, cs) {
    for (const sub of this.subscribers) {
      if (sub.channel === 'codeshareUpdates' && sub.shortId === shortId) {
        this.sendData(sub.ws, sub.subId, {
          codeshareUpdates: {
            codeshare: formatCodeshareNode(cs, sub.userId)
          }
        });
      }
    }
  }

  publishMeUpdated(rawUserId, user) {
    for (const sub of this.subscribers) {
      if (sub.channel === 'meUpdates' && sub.userId === rawUserId) {
        this.sendData(sub.ws, sub.subId, {
          meUpdates: {
            me: formatMeNode(user)
          }
        });
      }
    }
  }

  sendData(ws, subId, data) {
    if (ws && ws.readyState === 1) {
      ws.send(
        JSON.stringify({
          type: 'data',
          id: subId,
          payload: { data }
        })
      );
    }
  }
}

const pubsub = new PubSubBroker();

// ============================================================================
// GraphQL Operation Executor (Supports both Relay Queries/Mutations & Named Ops)
// ============================================================================
async function executeGraphQLOperation({
  operationName,
  query = '',
  variables = {},
  context = {}
}) {
  const { user, session, res } = context;
  const viewerRawId = user ? user.id : 'anon:guest';
  const opText = String(query || '');
  const opName = String(operationName || '');
  const input = variables.input || variables || {};

  try {
    // ------------------------------------------------------------------------
    // 1. MUTATIONS
    // ------------------------------------------------------------------------
    if (opName.includes('createCodeshare') || /\bcreateCodeshare\s*\(/.test(opText)) {
      const cs = db.createCodeshare(user);
      const node = formatCodeshareNode(cs, viewerRawId);
      return {
        data: {
          createCodeshare: {
            newCodeshareEdge: {
              node,
              cursor: encodeRelayConnId(0)
            }
          }
        }
      };
    }

    if (opName.includes('createCodeHistory') || /\bcreateCodeHistory\s*\(/.test(opText)) {
      const shortId = decodeShortCodeshareId(input.codeshareId);
      const historyRecord = db.createCodeHistory({
        shortId,
        rawUserId: viewerRawId,
        clientId: input.clientId || null,
        historyId: input.historyId,
        value: input.value
      });
      pubsub.publishCodeHistoryCreated(shortId, historyRecord);
      return {
        data: {
          createCodeHistory: {
            newCodeHistoryEdge: formatCodeHistoryEdge(
              historyRecord,
              historyRecord.index,
              viewerRawId
            )
          }
        }
      };
    }

    if (opName.includes('updateCodeshare') || /\bupdateCodeshare\s*\(/.test(opText)) {
      const shortId = decodeShortCodeshareId(input.id || input.codeshareId);
      const cs = db.updateCodeshare(shortId, viewerRawId, input);
      pubsub.publishCodeshareUpdated(cs.id, cs);
      return {
        data: {
          updateCodeshare: {
            codeshare: formatCodeshareNode(cs, viewerRawId)
          }
        }
      };
    }

    if (opName.includes('deleteCodeshare') || /\bdeleteCodeshare\s*\(/.test(opText)) {
      const shortId = decodeShortCodeshareId(input.id || input.codeshareId);
      const encodedId = encodeRelayId('Codeshare', shortId);
      db.deleteCodeshare(shortId);
      return {
        data: {
          deleteCodeshare: {
            deletedCodeshareId: encodedId
          }
        }
      };
    }

    if (
      opName.includes('upsertMeIntoCodeshareUsers') ||
      /\bupsertMeIntoCodeshareUsers\s*\(/.test(opText)
    ) {
      const shortId = decodeShortCodeshareId(input.codeshareId);
      const record = db.upsertCodeshareUser({
        shortId,
        rawUserId: viewerRawId,
        cursor: input.cursor,
        color: input.color
      });
      pubsub.publishCodeshareUserUpserted(shortId, record);
      return {
        data: {
          upsertMeIntoCodeshareUsers: {
            codeshareUserEdge: formatCodeshareUserEdge(record, 0, viewerRawId)
          }
        }
      };
    }

    // --- AUTH MUTATIONS (Executed over HTTP POST with x-codeshare-auth-mutation: true) ---
    if (opName === 'LoginFormMutation' || /\blogin\s*\(/.test(opText)) {
      const loggedInUser = db.loginUser({
        email: input.email,
        password: input.password
      });
      if (session) {
        db.updateSessionUser(session.sid, loggedInUser.id);
        if (res && typeof res.cookie === 'function') {
          setSessionCookies(res, session.sid);
        }
      }
      return {
        data: {
          login: {
            me: formatMeNode(loggedInUser),
            token: signJwt(loggedInUser.id)
          }
        }
      };
    }

    if (opName === 'RegisterFormMutation' || /\bregister\s*\(/.test(opText)) {
      const registeredUser = db.registerUser({
        currentAnonUser: user,
        name: input.name,
        email: input.email,
        password: input.password,
        settings: input.settings
      });
      if (session) {
        db.updateSessionUser(session.sid, registeredUser.id);
        if (res && typeof res.cookie === 'function') {
          setSessionCookies(res, session.sid);
        }
      }
      return {
        data: {
          register: {
            me: formatMeNode(registeredUser),
            token: signJwt(registeredUser.id)
          }
        }
      };
    }

    if (opName.includes('logout') || /\blogout\s*\(/.test(opText)) {
      const newAnon = db.createAnonymousUser();
      if (session) {
        db.updateSessionUser(session.sid, newAnon.id);
        if (res && typeof res.cookie === 'function') {
          setSessionCookies(res, session.sid);
        }
      }
      return {
        data: {
          logout: {
            me: formatMeNode(newAnon),
            token: signJwt(newAnon.id)
          }
        }
      };
    }

    if (opName.includes('deleteMe') || /\bdeleteMe\s*\(/.test(opText)) {
      const deletedId = encodeRelayId('Me', viewerRawId);
      db.deleteUser(viewerRawId);
      const newAnon = db.createAnonymousUser();
      if (session) {
        db.updateSessionUser(session.sid, newAnon.id);
        if (res && typeof res.cookie === 'function') {
          setSessionCookies(res, session.sid);
        }
      }
      return {
        data: {
          deleteMe: {
            deletedMeId: deletedId,
            me: formatMeNode(newAnon)
          }
        }
      };
    }

    if (opName.includes('updateMe') || /\bupdateMe\s*\(/.test(opText)) {
      const updatedUser = db.updateUser(viewerRawId, input);
      pubsub.publishMeUpdated(viewerRawId, updatedUser);
      return {
        data: {
          updateMe: {
            me: formatMeNode(updatedUser)
          }
        }
      };
    }

    if (
      opName.includes('subscribeToCodesharePro') ||
      /\bsubscribeToCodesharePro\s*\(/.test(opText)
    ) {
      db.createSubscriptionPlan({
        userId: viewerRawId,
        planId: 'pro',
        isActive: true,
        stripePaymentMethodId: input.stripePaymentMethodId || 'pm_card_visa'
      });
      const updatedUser = db.getUserByRawId(viewerRawId);
      pubsub.publishMeUpdated(viewerRawId, updatedUser);
      return {
        data: {
          subscribeToCodesharePro: {
            me: formatMeNode(updatedUser)
          }
        }
      };
    }

    if (
      opName.includes('createPasswordReset') ||
      /\bcreatePasswordReset\s*\(/.test(opText)
    ) {
      const token = db.createPasswordReset(input.email);
      return {
        data: {
          createPasswordReset: {
            clientMutationId: input.clientMutationId || null,
            resetToken: token
          }
        }
      };
    }

    if (opName.includes('usePasswordReset') || /\busePasswordReset\s*\(/.test(opText)) {
      const updatedUser = db.usePasswordReset(input.token, input.password);
      if (session) {
        db.updateSessionUser(session.sid, updatedUser.id);
        if (res && typeof res.cookie === 'function') {
          setSessionCookies(res, session.sid);
        }
      }
      return {
        data: {
          usePasswordReset: {
            me: formatMeNode(updatedUser)
          }
        }
      };
    }

    // --- ADMIN MUTATIONS (/_/admin) ---
    if (
      opName.includes('CreateSubscriptionPlan') ||
      /\bcreateSubscriptionPlan\s*\(/.test(opText)
    ) {
      let targetUserId = input.userId;
      try {
        targetUserId = decodeRelayId('User', targetUserId);
      } catch (_) {}
      const plan = db.createSubscriptionPlan({
        userId: targetUserId,
        planId: input.planId || 'pro',
        isActive: true
      });
      const targetUser = db.getUserByRawId(targetUserId);
      return {
        data: {
          createSubscriptionPlan: {
            user: formatUserNode(targetUser),
            subscriptionPlanEdge: {
              node: {
                id: encodeRelayId('SubscriptionPlan', plan.id),
                planId: plan.planId,
                isActive: plan.isActive
              }
            }
          }
        }
      };
    }

    if (
      opName.includes('updateSubscriptionPlan') ||
      /\bupdateSubscriptionPlan\s*\(/.test(opText)
    ) {
      let rawPlanId = input.id;
      try {
        rawPlanId = decodeRelayId('SubscriptionPlan', rawPlanId);
      } catch (_) {}
      const plan = db.updateSubscriptionPlan(rawPlanId, {
        isActive: input.isActive,
        planId: input.planId
      });
      return {
        data: {
          updateSubscriptionPlan: {
            subscriptionPlan: {
              id: encodeRelayId('SubscriptionPlan', plan.id),
              planId: plan.planId,
              isActive: plan.isActive
            }
          }
        }
      };
    }

    if (
      opName.includes('deleteSubscriptionPlan') ||
      /\bdeleteSubscriptionPlan\s*\(/.test(opText)
    ) {
      let rawPlanId = input.id;
      try {
        rawPlanId = decodeRelayId('SubscriptionPlan', rawPlanId);
      } catch (_) {}
      const encodedId = encodeRelayId('SubscriptionPlan', rawPlanId);
      db.deleteSubscriptionPlan(rawPlanId);
      return {
        data: {
          deleteSubscriptionPlan: {
            deletedSubscriptionPlanId: encodedId
          }
        }
      };
    }

    // ------------------------------------------------------------------------
    // 2. QUERIES
    // ------------------------------------------------------------------------
    if (
      opName === 'CodeshareIdQuery' ||
      opName === 'CodeshareIdCodeshareReconnectQuery' ||
      opName === 'CodeshareIdCodeHistoryQuery' ||
      opName === 'refetchableCodeHistoryEdgesRefetchQuery' ||
      opName === 'CodeshareIdUsersQuery' ||
      opName === 'refetchableCodeshareUserEdgesQuery' ||
      /\bcodeshare\s*\(/.test(opText)
    ) {
      const shortId = decodeShortCodeshareId(variables.codeshareId || variables.id);
      const cs = db.getOrCreateCodeshareByShortId(shortId, user);
      if (!cs) {
        const err = new Error('Codeshare not found');
        err.status = 404;
        throw err;
      }
      const formattedCs = formatCodeshareNode(cs, viewerRawId, {
        codeHistoryAfter: variables.codeHistoryAfter,
        codeHistoryFirst: variables.codeHistoryFirst
      });
      return {
        data: {
          viewer: {
            me: formatMeNode(user)
          },
          codeshare: formattedCs,
          node: formattedCs
        }
      };
    }

    if (
      opName === 'codesQuery' ||
      opName === 'CodesTablePaginationQuery' ||
      /\bcodeshares\s*\(/.test(opText)
    ) {
      const allSaved = db.getSavedCodesharesForUser(viewerRawId);
      let startIdx = 0;
      if (variables.after) {
        try {
          const decodedIdx = decodeRelayConnId(variables.after);
          if (!isNaN(decodedIdx)) startIdx = decodedIdx + 1;
        } catch (_) {}
      }
      const first = typeof variables.first === 'number' ? variables.first : 20;
      const slice = allSaved.slice(startIdx, startIdx + first);
      const edges = slice.map((cs, i) => ({
        node: formatCodeshareNode(cs, viewerRawId),
        cursor: encodeRelayConnId(startIdx + i)
      }));
      return {
        data: {
          viewer: {
            me: formatMeNode(user),
            codeshares: {
              edges,
              totalCount: allSaved.length,
              pageInfo: {
                endCursor: edges.length ? edges[edges.length - 1].cursor : null,
                hasNextPage: startIdx + first < allSaved.length
              }
            }
          }
        }
      };
    }

    if (opName === 'adminQuery' || /\buser\s*\(\s*email/.test(opText)) {
      const targetUser = variables.email ? db.getUserByEmail(variables.email) : null;
      return {
        data: {
          viewer: {
            me: formatMeNode(user),
            user: targetUser ? formatUserNode(targetUser) : null
          }
        }
      };
    }

    // Default viewer query (indexQuery, plansQuery, settingsQuery, CodeshareIdMeReconnectQuery)
    return {
      data: {
        viewer: {
          me: formatMeNode(user)
        }
      }
    };
  } catch (err) {
    return {
      data: null,
      errors: [
        {
          message: err.message || 'Internal Server Error',
          code: err.code || 'INTERNAL_ERROR',
          status: err.status || 500
        }
      ]
    };
  }
}

// ============================================================================
// WebSocket Server Handler (`subscriptions-transport-ws` / `codeshare-graphql-ws`)
// ============================================================================
function attachWebSocketHandler(wss) {
  wss.on('connection', (ws, req) => {
    const { user, session } = getOrCreateSession(req, null);
    let currentUser = user;
    const rateWindow = { count: 0, resetAt: Date.now() + 5000 };

    const keepAliveInterval = setInterval(() => {
      if (ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'ka' }));
      }
    }, 15000);

    ws.on('message', async (rawBuffer) => {
      const byteLength = Buffer.byteLength(rawBuffer);
      // Replicate Codeshare's 1009 POLICY_VIOLATION on oversized payload (>256 KB)
      if (byteLength > 256 * 1024) {
        ws.close(1009, 'Payload too large');
        return;
      }

      // Replicate Codeshare's 4008 RATE_LIMITED on excessive burst (>150 ops / 5s)
      const now = Date.now();
      if (now > rateWindow.resetAt) {
        rateWindow.count = 0;
        rateWindow.resetAt = now + 5000;
      }
      rateWindow.count++;
      if (rateWindow.count > 150) {
        ws.close(4008, 'Rate limited');
        return;
      }

      let msg;
      try {
        msg = JSON.parse(rawBuffer.toString('utf8'));
      } catch (_) {
        ws.close(1007, 'Invalid JSON');
        return;
      }

      // Refresh current user from session in case an HTTP auth mutation updated the session
      if (session) {
        const refreshedSess = db.getSession(session.sid);
        if (refreshedSess) {
          const refreshedUser = db.getUserByRawId(refreshedSess.userId);
          if (refreshedUser) currentUser = refreshedUser;
        }
      }

      if (msg.type === 'connection_init') {
        const initAuth =
          msg.payload && (msg.payload.authorization || msg.payload.Authorization);
        if (initAuth) {
          const jwtPayload = verifyJwt(initAuth);
          if (jwtPayload) {
            const matchedUser =
              db.getUserByRawId(jwtPayload.rawUserId) ||
              db.getUserByRawId(`anon:${jwtPayload.id}`) ||
              db.getUserByRawId(jwtPayload.id);
            if (matchedUser) {
              currentUser = matchedUser;
            }
          }
        }
        ws.send(JSON.stringify({ type: 'connection_ack' }));
        ws.send(JSON.stringify({ type: 'ka' }));
        return;
      }

      if (msg.type === 'start') {
        const subId = msg.id;
        const payload = msg.payload || {};
        const opName = String(payload.operationName || '');
        const query = String(payload.query || '');
        const variables = payload.variables || {};
        const input = variables.input || variables || {};

        // Check if this is one of the 5 GraphQL Subscriptions
        const isSubscription =
          /^\s*subscription\b/i.test(query) ||
          opName.includes('Subscription');

        if (isSubscription) {
          const shortId = decodeShortCodeshareId(input.codeshareId || input.id);
          let channel = null;
          if (
            opName.includes('onCodeHistoryCreations') ||
            query.includes('codeHistoryCreations')
          ) {
            channel = 'codeHistoryCreations';
          } else if (
            opName.includes('onCodeshareUserUpsertions') ||
            query.includes('codeshareUserUpsertions')
          ) {
            channel = 'codeshareUserUpsertions';
          } else if (
            opName.includes('onCodeshareUserDeletions') ||
            query.includes('codeshareUserDeletions')
          ) {
            channel = 'codeshareUserDeletions';
          } else if (
            opName.includes('CodeshareIdCodeshareSubscription') ||
            query.includes('codeshareUpdates')
          ) {
            channel = 'codeshareUpdates';
          } else if (
            opName.includes('CodeshareIdMeSubscription') ||
            query.includes('meUpdates')
          ) {
            channel = 'meUpdates';
          }

          if (channel) {
            pubsub.subscribe({
              ws,
              subId,
              channel,
              shortId,
              userId: currentUser.id
            });
          }
          return;
        }

        // Standard Query or Mutation multiplexed over WebSocket
        const result = await executeGraphQLOperation({
          operationName: opName,
          query,
          variables,
          context: { user: currentUser, session, res: null }
        });

        if (ws.readyState === 1) {
          ws.send(
            JSON.stringify({
              type: 'data',
              id: subId,
              payload: result
            })
          );
          ws.send(
            JSON.stringify({
              type: 'complete',
              id: subId
            })
          );
        }
        return;
      }

      if (msg.type === 'stop') {
        pubsub.unsubscribeById(ws, msg.id);
        if (ws.readyState === 1) {
          ws.send(JSON.stringify({ type: 'complete', id: msg.id }));
        }
        return;
      }

      if (msg.type === 'connection_terminate') {
        ws.close(1000, 'Closed by client');
      }
    });

    ws.on('close', () => {
      clearInterval(keepAliveInterval);
      const departed = pubsub.unsubscribeAllForSocket(ws);
      departed.forEach(({ shortId, userId }) => {
        const deletedRecord = db.removeCodeshareUser(shortId, userId);
        if (deletedRecord) {
          pubsub.publishCodeshareUserDeleted(shortId, deletedRecord);
        }
      });
    });
  });
}

module.exports = {
  executeGraphQLOperation,
  attachWebSocketHandler,
  pubsub,
  formatMeNode,
  formatUserNode,
  formatCodeshareNode
};

