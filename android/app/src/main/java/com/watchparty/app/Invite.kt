package com.watchparty.app

import android.app.Activity
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.widget.Toast

/** A party's invite link: on the host's own domain for the built-in server, as on the web. */
fun inviteLink(serverUrl: String, code: String): String {
    val server = Prefs.normalizeUrl(serverUrl)
    val builtIn = server == Prefs.normalizeUrl(BuildConfig.DEFAULT_SERVER)
    val base = if (builtIn && BuildConfig.INVITE_HOST.isNotBlank()) "https://${BuildConfig.INVITE_HOST}" else server
    return "$base/join/${code.lowercase()}"
}

/** Opens the share sheet with a party's invite link. */
fun shareInvite(context: Context, code: String, link: String) {
    val send = Intent(Intent.ACTION_SEND)
        .setType("text/plain")
        .putExtra(Intent.EXTRA_TEXT, link)
        .putExtra(Intent.EXTRA_TITLE, "Popcorn Club party ${code.uppercase()}")
    val chooser = Intent.createChooser(send, "Invite friends")
    if (context !is Activity) chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    context.startActivity(chooser)
}

fun copyInvite(context: Context, link: String) {
    context.getSystemService(ClipboardManager::class.java)?.setPrimaryClip(ClipData.newPlainText("Invite link", link))
    Toast.makeText(context, "Invite link copied", Toast.LENGTH_SHORT).show()
}
