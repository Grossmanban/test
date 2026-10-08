/* Подключение синхронизации к вашему проекту Supabase (необязательно).
 *
 * Где взять значения: панель Supabase → ваш проект → Project Settings → API Keys / Data API:
 *   supabaseUrl      — Project URL, вида https://abcdefghijklmnop.supabase.co
 *   supabaseAnonKey  — публичный ключ: «Publishable key» (sb_publishable_…) или legacy «anon public» (eyJ…)
 *
 * Этот ключ публичный по замыслу Supabase: он и так виден любому, кто откроет сайт, и даёт ровно те права,
 * которые разрешают политики RLS из supabase/schema.sql — каждый пользователь видит и меняет только свои записи.
 * Никогда не вставляйте сюда secret key (sb_secret_…) или service_role — они обходят RLS.
 *
 * Можно оставить пустым: тогда адрес и ключ вводятся в самом приложении (окно «Синхронизация»)
 * и хранятся только на этом устройстве. Значения из этого файла действуют на всех устройствах сразу.
 */
window.BUDGET_CONFIG = { supabaseUrl: "", supabaseAnonKey: "" };
