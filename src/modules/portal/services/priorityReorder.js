const pool = require("../../../db/pool");

async function reorderRestaurantPriorities(executor = pool) {
  const [rows] = await executor.execute(
    "SELECT restaurant_id FROM restaurant_priorities ORDER BY priority_rank ASC, restaurant_id ASC"
  );
  let rank = 1;
  for (const row of rows) {
    await executor.execute("UPDATE restaurant_priorities SET priority_rank = ? WHERE restaurant_id = ?", [
      rank,
      row.restaurant_id,
    ]);
    rank += 1;
  }
  return rank - 1;
}

async function getPriorityBounds(executor) {
  const [[row]] = await executor.execute(
    "SELECT COUNT(*) AS cnt, COALESCE(MAX(priority_rank), 0) AS max_rank FROM restaurant_priorities"
  );
  const count = Number(row?.cnt || 0);
  return { count, maxRank: Math.max(count, Number(row?.max_rank || 0)) };
}

async function findOccupantAtRank(executor, rank, excludeRestaurantId) {
  const [[row]] = await executor.execute(
    `SELECT rp.restaurant_id, rp.priority_rank AS priority, r.name
     FROM restaurant_priorities rp
     INNER JOIN restaurants r ON r.id = rp.restaurant_id
     WHERE rp.priority_rank = ? AND rp.restaurant_id != ?
     LIMIT 1`,
    [rank, excludeRestaurantId]
  );
  return row || null;
}

/**
 * Move a restaurant to a new priority.
 * If another restaurant already has that rank, they swap (occupant takes the mover's old rank).
 * Otherwise ranks between old and new shift up or down, then the list is compacted to 1..n.
 */
async function moveRestaurantPriority(executor, restaurantId, requestedRank, updatedByUserId = null) {
  const [[moved]] = await executor.execute(
    "SELECT priority_rank FROM restaurant_priorities WHERE restaurant_id = ? LIMIT 1",
    [restaurantId]
  );
  if (!moved) {
    const err = new Error("Restaurant not in priority list");
    err.code = "NOT_FOUND";
    throw err;
  }

  const oldRank = Number(moved.priority_rank);
  const { count } = await getPriorityBounds(executor);
  const newRank = Math.max(1, Math.min(Number(requestedRank), Math.max(count, 1)));

  if (oldRank === newRank) {
    return { oldRank, newRank, swappedWith: null, shifted: false };
  }

  const occupant = await findOccupantAtRank(executor, newRank, restaurantId);
  let swappedWith = null;
  let shifted = false;

  if (occupant) {
    await executor.execute(
      "UPDATE restaurant_priorities SET priority_rank = ?, updated_by_user_id = ? WHERE restaurant_id = ?",
      [oldRank, updatedByUserId, occupant.restaurant_id]
    );
    await executor.execute(
      "UPDATE restaurant_priorities SET priority_rank = ?, updated_by_user_id = ? WHERE restaurant_id = ?",
      [newRank, updatedByUserId, restaurantId]
    );
    swappedWith = {
      restaurantId: occupant.restaurant_id,
      name: occupant.name,
      fromRank: newRank,
      toRank: oldRank,
    };
  } else {
    shifted = true;
    if (newRank < oldRank) {
      await executor.execute(
        `UPDATE restaurant_priorities
         SET priority_rank = priority_rank + 1
         WHERE priority_rank >= ? AND priority_rank < ?`,
        [newRank, oldRank]
      );
    } else {
      await executor.execute(
        `UPDATE restaurant_priorities
         SET priority_rank = priority_rank - 1
         WHERE priority_rank > ? AND priority_rank <= ?`,
        [oldRank, newRank]
      );
    }
    await executor.execute(
      "UPDATE restaurant_priorities SET priority_rank = ?, updated_by_user_id = ? WHERE restaurant_id = ?",
      [newRank, updatedByUserId, restaurantId]
    );
  }

  await reorderRestaurantPriorities(executor);

  return { oldRank, newRank, swappedWith, shifted };
}

async function insertRestaurantPriorityAtRank(executor, restaurantId, requestedRank, active, updatedByUserId) {
  const { count } = await getPriorityBounds(executor);
  const newRank = Math.max(1, Math.min(Number(requestedRank), count + 1));

  await executor.execute(
    `UPDATE restaurant_priorities
     SET priority_rank = priority_rank + 1
     WHERE priority_rank >= ?`,
    [newRank]
  );

  await executor.execute(
    `INSERT INTO restaurant_priorities (restaurant_id, priority_rank, is_active, updated_by_user_id)
     VALUES (?, ?, ?, ?)`,
    [restaurantId, newRank, active, updatedByUserId]
  );
  await reorderRestaurantPriorities(executor);
  return { newRank };
}

function buildConflictResponse(occupant, oldRank, newRank) {
  return {
    conflict: true,
    message: `Priority ${newRank} is used by "${occupant.name}". Confirm to move "${occupant.name}" to priority ${oldRank} and reorder the list.`,
    occupant: {
      restaurantId: occupant.restaurant_id,
      name: occupant.name,
      priority: Number(occupant.priority),
    },
    currentRank: oldRank,
    requestedRank: newRank,
  };
}

module.exports = {
  reorderRestaurantPriorities,
  moveRestaurantPriority,
  insertRestaurantPriorityAtRank,
  findOccupantAtRank,
  buildConflictResponse,
};
