INSERT INTO community_server_rail (user_id, entries)
SELECT owner.user_id, (
  SELECT json_group_array(json(entry))
  FROM (
    SELECT json_object('kind', 'server', 'id', member.server_id) AS entry,
      0 AS section, COALESCE(member.rail_order, 0) AS position,
      member.joined_at AS joined_at, member.server_id AS id
    FROM community_server_member AS member
    WHERE member.user_id = owner.user_id
      AND NOT EXISTS (
        SELECT 1 FROM community_server_folder_item AS item
        JOIN community_server_folder AS folder ON folder.id = item.folder_id
        WHERE folder.user_id = owner.user_id AND item.server_id = member.server_id
      )
    UNION ALL
    SELECT json_object('kind', 'folder', 'id', folder.id),
      1, COALESCE(folder.position, 0), '', folder.id
    FROM community_server_folder AS folder
    WHERE folder.user_id = owner.user_id
      AND EXISTS (
        SELECT 1 FROM community_server_folder_item AS item
        JOIN community_server_member AS member ON member.server_id = item.server_id
          AND member.user_id = owner.user_id
        WHERE item.folder_id = folder.id
      )
    ORDER BY section, position, joined_at, id
  )
)
FROM (SELECT DISTINCT user_id FROM community_server_member) AS owner
WHERE NOT EXISTS (SELECT 1 FROM community_server_rail AS rail WHERE rail.user_id = owner.user_id);

DROP INDEX idx_server_member_user_rail_order;
ALTER TABLE community_server_member DROP COLUMN rail_order;
DROP INDEX idx_server_folder_user_position;
ALTER TABLE community_server_folder DROP COLUMN position;
CREATE INDEX idx_server_folder_user ON community_server_folder(user_id);
