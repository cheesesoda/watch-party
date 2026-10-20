package com.watchparty.app

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.CalendarContract
import android.widget.Toast
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withStyle
import java.text.DateFormat
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale

// Scheduled parties (Schedule, on the web): their times, the cards' wording, and what a friend sees using the code early.

private const val DAY_MS = 24 * 3600_000L

private fun startOfDay(t: Long): Long = Calendar.getInstance().apply {
    timeInMillis = t
    set(Calendar.HOUR_OF_DAY, 0)
    set(Calendar.MINUTE, 0)
    set(Calendar.SECOND, 0)
    set(Calendar.MILLISECOND, 0)
}.timeInMillis

private fun daysBetween(now: Long, at: Long): Int = Math.round((startOfDay(at) - startOfDay(now)).toDouble() / DAY_MS).toInt()

private fun time(at: Long): String = DateFormat.getTimeInstance(DateFormat.SHORT).format(Date(at))

/** "Sat, Oct 24 at 8:00 PM", in this device's time zone. */
fun whenLong(at: Long): String = SimpleDateFormat("EEE, MMM d", Locale.getDefault()).format(Date(at)) + " at " + time(at)

/** "TODAY 8:00 PM", "SAT 8:00 PM" within the week, else "OCT 31, 8:00 PM": a card's badge. */
fun whenShort(at: Long, now: Long = System.currentTimeMillis()): String {
    val days = daysBetween(now, at)
    return when {
        days == 0 -> "Today ${time(at)}"
        days == 1 -> "Tomorrow ${time(at)}"
        days in 2..6 -> SimpleDateFormat("EEE", Locale.getDefault()).format(Date(at)) + " " + time(at)
        else -> SimpleDateFormat("MMM d", Locale.getDefault()).format(Date(at)) + ", " + time(at)
    }.uppercase()
}

/** "Coming up in 4 days", "Coming up tomorrow", "Coming up in 3 hours". */
fun comingUp(at: Long, now: Long = System.currentTimeMillis()): String {
    val days = daysBetween(now, at)
    if (days > 1) return "Coming up in $days days"
    if (days == 1) return "Coming up tomorrow"
    val mins = ((at - now) / 60_000).coerceAtLeast(1)
    if (mins < 60) return "Coming up in $mins minute${if (mins == 1L) "" else "s"}"
    val hours = Math.round(mins / 60.0)
    return "Coming up in $hours hour${if (hours == 1L) "" else "s"}"
}

/** "Charade", or "Reacher · S2 E1" for an episode, as the server names it on invites. */
fun partyTitle(media: MediaItem?): String {
    if (media == null) return "A watch party"
    val ep = media.episode ?: return media.meta?.title ?: media.title
    return "${media.meta?.show ?: ep.show} · ${episodeLabel(ep.season, ep.episode)}"
}

/** A scheduled party's invite carries its title and time, so the invite page can show them while the host's PC is off. */
fun scheduledLink(serverUrl: String, party: ScheduledParty): String =
    inviteLink(serverUrl, party.id) + "?t=" + Uri.encode(partyTitle(party.media)) + "&at=" + party.at

/**
 * Opens the calendar app with the party filled in: its time, and the invite link and code in the notes. (The calendar
 * app's own default reminder applies; an app can't add one this way.)
 */
fun addToCalendar(context: Context, invite: PartyInvite, link: String) {
    val length = invite.duration?.takeIf { it > 60 }?.let { (it * 1000).toLong() } ?: (2 * 3600_000L)
    val intent = Intent(Intent.ACTION_INSERT)
        .setData(CalendarContract.Events.CONTENT_URI)
        .putExtra(CalendarContract.EXTRA_EVENT_BEGIN_TIME, invite.at)
        .putExtra(CalendarContract.EXTRA_EVENT_END_TIME, invite.at + length)
        .putExtra(CalendarContract.Events.TITLE, "${invite.title} watch party")
        .putExtra(CalendarContract.Events.DESCRIPTION, (invite.host?.let { "$it's party. " } ?: "") + "Join: $link\nParty code: ${invite.id.uppercase()}")
        .putExtra(CalendarContract.Events.EVENT_LOCATION, link)
    try {
        context.startActivity(intent)
    } catch (e: ActivityNotFoundException) {
        Toast.makeText(context, "No calendar app on this device.", Toast.LENGTH_SHORT).show()
    }
}

/** A friend used a scheduled party's code before it opens. Phones also get Add to calendar. */
@Composable
fun NotStartedDialog(invite: PartyInvite, tv: Boolean, onCalendar: () -> Unit, onDismiss: () -> Unit) {
    val bold = SpanStyle(color = Color.White, fontWeight = FontWeight.SemiBold)
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("This party hasn't started yet") },
        text = {
            Text(buildAnnotatedString {
                if (invite.host != null) append("${invite.host}'s ")
                withStyle(bold) { append(invite.title) }
                append(if (invite.host != null) " party starts " else " starts ")
                withStyle(bold) { append(whenLong(invite.at).replace(" PM", " PM").replace(" AM", " AM")) }
                append(". Come back then and use the same code.")
            })
        },
        confirmButton = { DialogButton("OK", onClick = onDismiss) },
        dismissButton = { if (!tv) DialogButton("Add to calendar", onClick = onCalendar) },
        containerColor = DialogSurface,
    )
}

/** The host picked a scheduled party: start it now (same code), cancel it, or go back. Start now has the focus. */
@Composable
fun StartScheduledDialog(party: ScheduledParty, onStart: () -> Unit, onCancelParty: () -> Unit, onDismiss: () -> Unit) {
    val start = remember { FocusRequester() }
    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Column(
            Modifier
                .padding(24.dp)
                .widthIn(max = 460.dp)
                .clip(RoundedCornerShape(28.dp))
                .background(DialogSurface)
                .padding(24.dp),
        ) {
            Text("Start ${partyTitle(party.media)} now?", color = Color.White, fontSize = 24.sp, lineHeight = 32.sp)
            Text(
                "It's scheduled for ${whenLong(party.at)}. Starting now opens it with the same code, so friends can join.",
                color = Muted,
                fontSize = 14.sp,
                lineHeight = 20.sp,
                modifier = Modifier.padding(top = 16.dp),
            )
            // Cancel party sits apart on the left in warm red, like End party: it affects everyone with the code.
            Row(Modifier.fillMaxWidth().padding(top = 24.dp), verticalAlignment = Alignment.CenterVertically) {
                DialogButton("Cancel party", danger = true, onClick = onCancelParty)
                Spacer(Modifier.weight(1f))
                DialogButton("Back", onClick = onDismiss)
                DialogButton("Start now", modifier = Modifier.focusRequester(start), onClick = onStart)
            }
        }
    }
    LaunchedEffect(Unit) { runCatching { start.requestFocus() } }
}
