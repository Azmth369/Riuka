// /chats + /chat-messages endpoint backend — web AI-chat history in the
// chat_conversations / chat_messages tables (Riuka-only; RLS with no anon
// policies, written via the service-role client server-side).

const { supabase } = require('./db');

async function listConversations(clanTag) {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from('chat_conversations')
    .select('id, title, created_at, updated_at')
    .eq('clan_tag', clanTag)
    .order('updated_at', { ascending: false })
    .limit(100);
  if (error) throw new Error(error.message);
  return data || [];
}

async function createConversation(clanTag, title) {
  if (!supabase) return null;
  const { data, error } = await supabase
    .from('chat_conversations')
    .insert({ clan_tag: clanTag, title: title || 'New chat' })
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data;
}

async function deleteConversation(id) {
  if (!supabase) return null;
  const { error } = await supabase
    .from('chat_conversations')
    .delete()
    .eq('id', id);
  if (error) throw new Error(error.message);
  return true;
}

async function getMessages(conversationId) {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from('chat_messages')
    .select('role, content, created_at')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true })
    .limit(500);
  if (error) throw new Error(error.message);
  return data || [];
}

async function addMessage(conversationId, role, content) {
  if (!supabase) return null;
  const { error: msgError } = await supabase
    .from('chat_messages')
    .insert({ conversation_id: conversationId, role, content });
  if (msgError) throw new Error(msgError.message);

  const { error: touchError } = await supabase
    .from('chat_conversations')
    .update({ updated_at: new Date().toISOString() })
    .eq('id', conversationId);
  if (touchError) throw new Error(touchError.message);
  return true;
}

module.exports = { listConversations, createConversation, deleteConversation, getMessages, addMessage };
