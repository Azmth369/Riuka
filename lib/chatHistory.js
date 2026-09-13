const { supabase } = require('./supabaseClient');

// Table names after the rename:
//   chat_conversations_title -> one row per conversation (id, title, clan_tag, updated_at)
//   chat_conversations       -> one row per message (conversation_id, role, content, created_at)

async function listConversations(clanTag) {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from('chat_conversations_title')
    .select('id, title, updated_at')
    .eq('clan_tag', clanTag)
    .order('updated_at', { ascending: false });
  if (error) throw new Error(error.message);
  return data || [];
}

async function createConversation(clanTag, title) {
  if (!supabase) return null;
  const { data, error } = await supabase
    .from('chat_conversations_title')
    .insert({ clan_tag: clanTag, title })
    .select();
  if (error) throw new Error(error.message);
  return data?.[0] || null;
}

async function deleteConversation(id) {
  if (!supabase) return null;
  const { error } = await supabase
    .from('chat_conversations_title')
    .delete()
    .eq('id', id);
  if (error) throw new Error(error.message);
  return true;
}

async function getMessages(conversationId) {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from('chat_conversations')
    .select('role, content, created_at')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true });
  if (error) throw new Error(error.message);
  return data || [];
}

async function addMessage(conversationId, role, content) {
  if (!supabase) return null;
  const { error: msgError } = await supabase
    .from('chat_conversations')
    .insert({ conversation_id: conversationId, role, content });
  if (msgError) throw new Error(msgError.message);

  // Bump the conversation's updated_at so the history list sorts by recency.
  const { error: touchError } = await supabase
    .from('chat_conversations_title')
    .update({ updated_at: new Date().toISOString() })
    .eq('id', conversationId);
  if (touchError) throw new Error(touchError.message);

  return true;
}

module.exports = { listConversations, createConversation, deleteConversation, getMessages, addMessage };
