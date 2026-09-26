import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import webpush from "https://esm.sh/web-push@3.6.7";

const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS"
};

function jsonResponse(body: Record<string, unknown>, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: {
            ...corsHeaders,
            "Content-Type": "application/json"
        }
    });
}

Deno.serve(async request => {
    if (request.method === "OPTIONS") {
        return new Response("ok", { headers: corsHeaders });
    }

    if (request.method !== "POST") {
        return jsonResponse({ error: "Method not allowed" }, 405);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const vapidPublicKey = Deno.env.get("VAPID_PUBLIC_KEY");
    const vapidPrivateKey = Deno.env.get("VAPID_PRIVATE_KEY");

    if (!supabaseUrl || !anonKey || !serviceRoleKey || !vapidPublicKey || !vapidPrivateKey) {
        return jsonResponse({ error: "Push secrets are not configured" }, 500);
    }

    const authorization = request.headers.get("Authorization");

    if (!authorization) {
        return jsonResponse({ error: "Missing authorization" }, 401);
    }

    const userClient = createClient(supabaseUrl, anonKey, {
        global: {
            headers: {
                Authorization: authorization
            }
        }
    });
    const { data: { user }, error: userError } = await userClient.auth.getUser();

    if (userError || !user) {
        return jsonResponse({ error: "Unauthorized" }, 401);
    }

    const payload = await request.json();
    const title = typeof payload.title === "string" ? payload.title : "Work Up";
    const body = typeof payload.body === "string" ? payload.body : "Tu as un rappel à consulter.";
    const adminClient = createClient(supabaseUrl, serviceRoleKey);
    const { data: subscriptions, error: subscriptionError } = await adminClient
        .from("push_subscriptions")
        .select("id, endpoint, subscription")
        .eq("user_id", user.id);

    if (subscriptionError) {
        return jsonResponse({ error: subscriptionError.message }, 500);
    }

    webpush.setVapidDetails(
        "mailto:leo-thev@users.noreply.github.com",
        vapidPublicKey,
        vapidPrivateKey
    );

    let sent = 0;
    const expiredIds: number[] = [];

    for (const subscription of subscriptions || []) {
        try {
            await webpush.sendNotification(
                subscription.subscription,
                JSON.stringify({ title, body, url: "https://leo-thev.github.io/Work-Up/" })
            );
            sent += 1;
        } catch (error) {
            const statusCode = (error as { statusCode?: number }).statusCode;

            if (statusCode === 404 || statusCode === 410) {
                expiredIds.push(subscription.id);
            }
        }
    }

    if (expiredIds.length > 0) {
        await adminClient
            .from("push_subscriptions")
            .delete()
            .in("id", expiredIds);
    }

    return jsonResponse({ sent, removed: expiredIds.length });
});
