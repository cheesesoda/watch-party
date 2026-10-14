package com.watchparty.app

import org.junit.Assert.assertEquals
import org.junit.Test

class LibraryBrowseTest {
    private fun movie(title: String, addedAt: Long = 0, size: Long = 1, folder: String = "Movies") =
        MediaItem(id = title, title = title, relPath = "$folder/$title.mkv", folder = folder, size = size, addedAt = addedAt)

    private fun ep(show: String, season: Int, n: Int) = MediaItem(
        id = "$show$season$n", title = "$show S$season E$n", relPath = "TV/$show/$season/$n.mkv", folder = "TV/$show/$season",
        episode = EpisodeInfo(show, season, n),
    )

    private val items = listOf(
        movie("Episode 10", addedAt = 1), movie("alien", addedAt = 3, size = 5), movie("Episode 2", addedAt = 2),
        ep("Severance", 2, 1), ep("Severance", 1, 2), ep("Severance", 1, 1), ep("The Bear", 1, 1),
    )

    private fun titles(rows: List<LibraryRow>) =
        rows.map { if (it is LibraryRow.Video) it.item.title else (it as LibraryRow.ShowRow).show.name }

    @Test
    fun everythingSortsFilmsAndShowsTogetherByName() {
        val rows = libraryRows(items, LibraryView.All, null, false, "", LibrarySort.AZ)
        assertEquals(listOf("alien", "Episode 2", "Episode 10", "Severance", "The Bear"), titles(rows))
    }

    @Test
    fun moviesLeaveOutEpisodesAndSortByNewest() {
        val rows = libraryRows(items, LibraryView.Movies, null, false, "", LibrarySort.Recent)
        assertEquals(listOf("alien", "Episode 2", "Episode 10"), titles(rows))
    }

    @Test
    fun showsAreGroupedInSeasonOrder() {
        val severance = shows(items).first()
        assertEquals("Severance", severance.name)
        assertEquals(listOf(1, 2), severance.seasons)
        assertEquals(listOf(1 to 1, 1 to 2, 2 to 1), severance.episodes.map { it.episode!!.season to it.episode!!.episode })
        assertEquals("2 seasons · 3 episodes", severance.summary)
    }

    @Test
    fun foldersTmdbMatchesToOneShowAreGroupedUnderItsName() {
        val meta = MediaMeta(tmdbId = 1, title = "Pilot", show = "Franklin & Bash")
        val list = listOf(ep("Franklin and Bash", 1, 1).copy(meta = meta), ep("Franklin And Bash", 1, 2).copy(meta = meta), ep("Other", 1, 1))
        val grouped = shows(list)
        assertEquals(listOf("Franklin & Bash", "Other"), grouped.map { it.name })
        assertEquals(listOf("Franklin and Bash", "Franklin And Bash"), grouped.first().aliases)
        val extra = movie("Gag reel").copy(extra = ExtraInfo("Extra", show = "Franklin And Bash"))
        assertEquals(listOf(extra), extrasOfShow(grouped.first(), extrasByOwner(list + extra)))
    }

    @Test
    fun foldersAndSearchNarrowTheList() {
        assertEquals(listOf("Severance", "The Bear"), titles(libraryRows(items, LibraryView.All, "TV", false, "", LibrarySort.AZ)))
        assertEquals(listOf("Episode 2", "Episode 10"), titles(libraryRows(items, LibraryView.Movies, null, false, "episode", LibrarySort.AZ)))
    }

    @Test
    fun extrasSitUnderTheirMovieUnlessSearching() {
        val burn = movie("Burn After Reading")
        val dc = MediaItem(id = "dc", title = "DC Insiders", relPath = "Movies/Burn/DC Insiders.mkv", extra = ExtraInfo("Behind the scenes", of = burn.id))
        val loose = MediaItem(id = "t", title = "Teaser", relPath = "Movies/Teaser.mkv", extra = ExtraInfo("Trailer"))
        val list = listOf(burn, dc, loose)
        assertEquals(listOf("Burn After Reading", "Teaser"), titles(libraryRows(list, LibraryView.All, null, false, "", LibrarySort.AZ)))
        assertEquals(listOf("DC Insiders"), titles(libraryRows(list, LibraryView.All, null, false, "insiders", LibrarySort.AZ)))
        assertEquals(mapOf(burn.id to listOf(dc)), extrasByOwner(list))
        assertEquals(listOf(burn), recentlyAdded(list, null))
    }

    @Test
    fun lengths() {
        assertEquals("2:01:00", formatLength(7260.0))
        assertEquals("50:00", formatLength(3000.0))
    }

    private fun aired(season: Int, n: Int, day: String?) = ep("Letterkenny", season, n).copy(meta = day?.let { MediaMeta(tmdbId = 1, title = "", airDate = it) })

    @Test
    fun specialsAreWovenInWhereTheyAired() {
        val show = listOf(
            aired(2, 1, "2017-12-25"), aired(1, 2, "2016-02-14"), aired(1, 1, "2016-02-07"), aired(2, 2, "2018-01-01"),
            aired(0, 3, null), aired(0, 2, "2017-12-25"), aired(0, 1, "2016-12-20"), aired(0, 4, "2015-01-01"),
        )
        val w = weave(show)
        val ids = { l: List<MediaItem> -> l.map { "${it.episode!!.season}x${it.episode!!.episode}" } }
        assertEquals(listOf("0x4", "1x1", "1x2", "0x1", "2x1", "0x2", "2x2", "0x3"), ids(w.all))
        assertEquals(listOf("0x4", "1x1", "1x2", "0x1"), ids(w.seasons.getValue(1)))
        assertEquals(listOf("2x1", "0x2", "2x2"), ids(w.seasons.getValue(2)))
        assertEquals(listOf("0x1", "0x2", "0x3", "0x4"), ids(w.specials))
        assertEquals(listOf(1, 2), Show("Letterkenny", w.all).seasons)
        assertEquals("Special 3", episodeLabel(0, 3))
    }
}
