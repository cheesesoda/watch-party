package com.watchparty.app

import android.content.Context

/** Server address, auth token and display name, kept in SharedPreferences. */
class Prefs(context: Context) {
    private val sp = context.getSharedPreferences("watch_party", Context.MODE_PRIVATE)

    var serverUrl: String
        get() = sp.getString("server", "") ?: ""
        set(v) = sp.edit().putString("server", v).apply()

    var token: String
        get() = sp.getString("token", "") ?: ""
        set(v) = sp.edit().putString("token", v).apply()

    var name: String
        get() = sp.getString("name", "") ?: ""
        set(v) = sp.edit().putString("name", v).apply()

    /** Code of the last party this device joined; fills in the code when signing in a TV. */
    var lastRoom: String
        get() = sp.getString("last_room", "") ?: ""
        set(v) = sp.edit().putString("last_room", v).apply()

    val isSetUp: Boolean
        get() = serverUrl.isNotBlank() && name.isNotBlank() && sp.getBoolean("signed_in", false)

    fun markSignedIn(signedIn: Boolean) = sp.edit().putBoolean("signed_in", signedIn).apply()

    companion object {
        /** "192.168.1.5:8080/" -> "http://192.168.1.5:8080" */
        fun normalizeUrl(input: String): String {
            var url = input.trim().trimEnd('/')
            if (url.isEmpty()) return url
            if (!url.startsWith("http://") && !url.startsWith("https://")) url = "http://$url"
            // Invite links look like https://host/join/ABC123 (older ones https://host/#/join/ABC123); keep only the server part.
            url = url.substringBefore("/#").substringBefore("#").substringBefore("/join/").substringBefore("/room/").trimEnd('/')
            return url
        }

        /** Pulls a room code out of an invite link or returns the input as a code. */
        fun roomCode(input: String): String {
            val trimmed = input.trim()
            val fromLink = Regex("""/(?:room|join)/([\w-]+)""").find(trimmed)?.groupValues?.get(1)
            return (fromLink ?: trimmed).lowercase()
        }
    }
}
