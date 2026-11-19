import { configureStore } from '@reduxjs/toolkit';
import { createApi } from '@reduxjs/toolkit/query/react';
import { api } from './lib.jsx';

const reportsTag = 'DailyWorkReports';

const dailyWorkApi = createApi({
  reducerPath: 'dailyWorkApi',
  tagTypes: [reportsTag],
  async baseQuery({ path, method, body }, { signal }) {
    try {
      return { data: await api(path, { method, body, signal }) };
    } catch (error) {
      return { error: { message: error.message, status: error.status } };
    }
  },
  endpoints: (build) => ({
    dailyWorkReport: build.query({
      query: (query) => ({ path: `/daily-work/reports?${query}` }),
      providesTags: [reportsTag],
    }),
    saveDailyTaskStatus: build.mutation({
      query: ({ date, memberId, entryId, status, reason, version }) => ({
        path: `/daily-work/day/${date}/members/${memberId}/entries/${entryId}/status`,
        method: 'PATCH',
        body: { status, reason, version },
      }),
      async onQueryStarted({ date, memberId, entryId }, { dispatch, getState, queryFulfilled }) {
        try {
          const { data } = await queryFulfilled;
          const queries = dailyWorkApi.util.selectCachedArgsForQuery(getState(), 'dailyWorkReport');
          for (const query of queries) {
            const status = new URLSearchParams(query).get('status');
            dispatch(dailyWorkApi.util.updateQueryData('dailyWorkReport', query, (report) => {
              const index = report.submissions.findIndex((item) => item.date === date && item.memberId === memberId);
              const submission = report.submissions[index];
              if (!submission || submission.version > data.version) return;
              submission.version = data.version;
              const entryIndex = submission.entries.findIndex((item) => item._id === entryId);
              const entry = submission.entries[entryIndex];
              if (!entry) return;
              if (status && data.entry.status !== status) {
                submission.entries.splice(entryIndex, 1);
                if (!submission.entries.length) report.submissions.splice(index, 1);
                return;
              }
              Object.assign(entry, data.entry, {
                incompleteReason: data.entry.incompleteReason,
                canUpdateStatus: entry.canUpdateStatus && !['done', 'unavailable'].includes(data.entry.workflowStatus),
              });
            }));
          }
        } catch ({ error }) {
          if (error?.status !== 409) return;
        }
        // A status change can add rows to another filter or affect a linked entry.
        dispatch(dailyWorkApi.util.invalidateTags([reportsTag]));
      },
    }),
  }),
});

export const { useDailyWorkReportQuery, useSaveDailyTaskStatusMutation } = dailyWorkApi;

export function createWorkflowStore() {
  return configureStore({
    reducer: { [dailyWorkApi.reducerPath]: dailyWorkApi.reducer },
    middleware: (getDefaultMiddleware) => getDefaultMiddleware().concat(dailyWorkApi.middleware),
  });
}
