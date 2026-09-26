import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import webpush from "https://esm.sh/web-push@3.6.7";

const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "content-type, x-cron-secret",
    "Access-Control-Allow-Methods": "POST, OPTIONS"
};

function response(body: Record<string, unknown>, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
}

function parisNow() {
    const parts = new Intl.DateTimeFormat("en-GB", {
        timeZone: "Europe/Paris",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23"
    }).formatToParts(new Date());
    const values = Object.fromEntries(parts.map(part => [part.type, part.value]));

    return {
        date: `${values.year}-${values.month}-${values.day}`,
        hour: Number(values.hour),
        minute: Number(values.minute)
    };
}

Deno.serve(async request => {
    if (request.method === "OPTIONS") {
        return new Response("ok", { headers: corsHeaders });
    }

    const cronSecret = Deno.env.get("CRON_SECRET");

    if (!cronSecret || request.headers.get("x-cron-secret") !== cronSecret) {
        return response({ error: "Unauthorized" }, 401);
    }

    const now = parisNow();

    if (now.minute !== 0 || ![12, 20].includes(now.hour)) {
        return response({ skipped: true, reason: "Outside reminder windows", now });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const vapidPublicKey = Deno.env.get("VAPID_PUBLIC_KEY");
    const vapidPrivateKey = Deno.env.get("VAPID_PRIVATE_KEY");

    if (!supabaseUrl || !serviceRoleKey || !vapidPublicKey || !vapidPrivateKey) {
        return response({ error: "Push secrets are not configured" }, 500);
    }

    const adminClient = createClient(supabaseUrl, serviceRoleKey);
    const reminderType = now.hour === 12 ? "top3" : "habits";
    const runKey = `${now.date}:${reminderType}`;
    const { error: runError } = await adminClient
        .from("push_reminder_runs")
        .insert({ run_key: runKey, reminder_type: reminderType });

    if (runError?.code === "23505") {
        return response({ skipped: true, reason: "Already sent", runKey });
    }

    if (runError) {
        return response({ error: runError.message }, 500);
    }

    const { data: rows, error: dataError } = await adminClient
        .from("user_data")
        .select("user_id, data");

    if (dataError) {
        return response({ error: dataError.message }, 500);
    }

    webpush.setVapidDetails(
        "mailto:leo-thev@users.noreply.github.com",
        vapidPublicKey,
        vapidPrivateKey
    );

    let sent = 0;
    const expiredSubscriptionIds: number[] = [];

    for (const row of rows || []) {
        const data = row.data || {};
        let title = "";
        let body = "";

        if (reminderType === "top3") {
            const priorities = data.workUpDailyPriorities;
            const incomplete = priorities?.date === now.date
                ? (priorities.items || []).filter((item: { done?: boolean }) => !item.done)
                : [];

            if (incomplete.length === 0) {
                continue;
            }

            title = "Top 3 du jour";
            body = `Il te reste ${incomplete.length} priorité${incomplete.length > 1 ? "s" : ""} à accomplir.`;
        } else {
            const habits = Array.isArray(data.workUpHabits) ? data.workUpHabits : [];
            const completions = data.workUpHabitCompletions || {};
            const incomplete = habits.filter((habit: { id: string }) => {
                return !completions[habit.id]?.[now.date];
            });

            if (incomplete.length === 0) {
                continue;
            }

            title = "Habitudes du jour";
            body = `Il te reste ${incomplete.length} habitude${incomplete.length > 1 ? "s" : ""} à compléter.`;
        }

        const { data: subscriptions } = await adminClient
            .from("push_subscriptions")
            .select("id, subscription")
            .eq("user_id", row.user_id);

        for (const subscription of subscriptions || []) {
            try {
                await webpush.sendNotification(
                    subscription.subscription,
                    JSON.stringify({
                        title,
                        body,
                        url: "https://leo-thev.github.io/Work-Up/"
                    })
                );
                sent += 1;
            } catch (error) {
                const statusCode = (error as { statusCode?: number }).statusCode;

                if (statusCode === 404 || statusCode === 410) {
                    expiredSubscriptionIds.push(subscription.id);
                }
            }
        }
    }

    if (expiredSubscriptionIds.length > 0) {
        await adminClient
            .from("push_subscriptions")
            .delete()
            .in("id", expiredSubscriptionIds);
    }

    return response({ sent, reminderType, date: now.date });
});
